#!/usr/bin/env bash
# Remote Careflow-style deploy for Laundry Express API (runs ON the VPS).
# Required env:
#   RELEASE_ID, LIVE_PATH, APP_URL, PM2_APP_NAME, DEPLOY_ROOT, APP_NAME
#   GITHUB_RUN_NUMBER, GITHUB_RUN_ID, GITHUB_ACTOR, GITHUB_REF_NAME (optional)
set -euo pipefail

export HOME="${HOME:-/home/sigisolutions}"
# shellcheck disable=SC1090
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" || true

APP_NAME="${APP_NAME:-laundry-api}"
RELEASE_ID="${RELEASE_ID:?RELEASE_ID required}"
LIVE_PATH="${LIVE_PATH:?LIVE_PATH required}"
APP_URL="${APP_URL:?APP_URL required}"
PM2_APP_NAME="${PM2_APP_NAME:?PM2_APP_NAME required}"
DEPLOY_ROOT="${DEPLOY_ROOT:?DEPLOY_ROOT required}"

DEPLOY_TS="$(date -u +%Y%m%d-%H%M%SZ)"
SHORT_SHA="$(printf '%s' "$RELEASE_ID" | cut -c1-8)"
RUN_NUMBER="${GITHUB_RUN_NUMBER:-0}"
RELEASE_NAME="release-${DEPLOY_TS}-run-${RUN_NUMBER}-${SHORT_SHA}"

INCOMING_FILE="$DEPLOY_ROOT/incoming/${RELEASE_ID}.tar.gz"
RELEASE_PATH="$DEPLOY_ROOT/releases/$RELEASE_NAME"
BACKUP_FILE="$DEPLOY_ROOT/backups/file-before-${RELEASE_NAME}.tar.gz"
DB_BACKUP_FILE="$DEPLOY_ROOT/db-backups/db-before-${RELEASE_NAME}.sql.gz"
ROLLBACK_DIR="$DEPLOY_ROOT/rollback-temp"
DEPLOY_LOG="$DEPLOY_ROOT/logs/deployments.log"

mkdir -p "$DEPLOY_ROOT"/{incoming,releases,backups,db-backups,logs}

ensure_node20() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    nvm use 20 >/dev/null 2>&1 || nvm use --lts >/dev/null 2>&1 || true
  fi
  if [ -d "$NVM_DIR/versions/node" ]; then
    LATEST20="$(ls -1 "$NVM_DIR/versions/node" 2>/dev/null | grep -E '^v20\.' | sort -V | tail -1 || true)"
    if [ -n "$LATEST20" ] && [ -x "$NVM_DIR/versions/node/$LATEST20/bin/node" ]; then
      export PATH="$NVM_DIR/versions/node/$LATEST20/bin:$PATH"
    fi
  fi
  hash -r 2>/dev/null || true
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "ERROR: Node 18+ required. Current: $(node -v 2>/dev/null || echo missing)"
    exit 1
  fi
  echo "node=$(command -v node) $(node -v) npm=$(npm -v)"
}

pick_laundry_db() {
  local config_path="$1"
  node <<JS
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('$config_path', 'utf8'));
function ph(c){return !c||!c.database||!c.username||/^your_/i.test(c.database)||/^your_/i.test(c.username);}
function laundry(c){const t=(c.database+' '+(c.username||'')).toLowerCase(); return /laund/.test(t) && !/fomino/.test(t);}
const preferred=['development','production','test'];
const entries=[];
Object.keys(raw||{}).forEach(k=>{const c=raw[k]; if(c&&c.database) entries.push({k,c});});
const L=entries.filter(e=>!ph(e.c)&&laundry(e.c));
for (const k of preferred){const h=L.find(e=>e.k===k); if(h){process.stdout.write(JSON.stringify(h.c)); process.exit(0);}}
if(L[0]){process.stdout.write(JSON.stringify(L[0].c)); process.exit(0);}
process.exit(2);
JS
}

rollback_files() {
  echo "Deployment failed — rolling back application files..."
  if [ ! -f "$BACKUP_FILE" ]; then
    echo "No file backup available."
    return 0
  fi
  rm -rf "$ROLLBACK_DIR"
  mkdir -p "$ROLLBACK_DIR"
  tar -xzf "$BACKUP_FILE" -C "$ROLLBACK_DIR"
  rsync -az --delete \
    --exclude=".env" \
    --exclude=".env.*" \
    --exclude=".htaccess" \
    --exclude=".well-known" \
    --exclude="uploads" \
    --exclude="Public" \
    --exclude="node_modules" \
    --exclude="config/config.json" \
    --exclude="firebase.json" \
    --exclude="*.pem" \
    --exclude="*.key" \
    "$ROLLBACK_DIR/" "$LIVE_PATH/"
  cd "$LIVE_PATH"
  ensure_node20
  npm ci --omit=dev || npm install --production
  if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
    pm2 reload "$PM2_APP_NAME" --update-env
  else
    pm2 start "$LIVE_PATH/laundary.js" --name "$PM2_APP_NAME" --cwd "$LIVE_PATH" --update-env
  fi
  pm2 save
  echo "File rollback completed. DB was NOT restored automatically."
  echo "DB backup (if created): $DB_BACKUP_FILE"
}

on_error() {
  local code=$?
  set +e
  trap - ERR
  echo "DEPLOY FAILED exit=$code"
  rollback_files
  exit "$code"
}
trap on_error ERR

echo "Deploy $APP_NAME release=$RELEASE_NAME live=$LIVE_PATH pm2=$PM2_APP_NAME"
test -f "$INCOMING_FILE"

rm -rf "$RELEASE_PATH"
mkdir -p "$RELEASE_PATH"
tar -xzf "$INCOMING_FILE" -C "$RELEASE_PATH"
test -f "$RELEASE_PATH/laundary.js"
test -f "$RELEASE_PATH/package.json"
test -d "$RELEASE_PATH/migrations"

cat > "$RELEASE_PATH/release-info.txt" <<EOF
$RELEASE_NAME
commit=$RELEASE_ID
branch=${GITHUB_REF_NAME:-}
run=${RUN_NUMBER}
runId=${GITHUB_RUN_ID:-}
actor=${GITHUB_ACTOR:-}
deployed_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pm2=$PM2_APP_NAME
livePath=$LIVE_PATH
deployRoot=$DEPLOY_ROOT
file_backup=$(basename "$BACKUP_FILE")
db_backup=$(basename "$DB_BACKUP_FILE")
EOF

PACKAGED_AT=""
if [ -f "$RELEASE_PATH/release.json" ]; then
  PACKAGED_AT="$(node -e "try{const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(j.packagedAt||j.deployedAt||'')}catch(e){}" "$RELEASE_PATH/release.json" || true)"
fi

FREE_KB="$(df -Pk "$DEPLOY_ROOT/backups" | awk 'NR==2 {print $4}')"
if [ -n "${FREE_KB:-}" ] && [ "$FREE_KB" -lt 1048576 ]; then
  echo "Less than 1GB free for backups"
  exit 1
fi

echo "Backing up live files..."
rm -f "$BACKUP_FILE"
tar \
  --exclude="./node_modules" \
  --exclude="./.git" \
  --exclude="./uploads" \
  --exclude="./Public" \
  --exclude="./backups" \
  --exclude="./.env" \
  --exclude="./.env.*" \
  --exclude="./*.log" \
  --exclude="./logs" \
  --exclude="./*.tar.gz" \
  --exclude="./*.zip" \
  -czf "$BACKUP_FILE" -C "$LIVE_PATH" .
test -s "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
ls -lh "$BACKUP_FILE"

echo "Backing up MySQL (laundry credentials only)..."
CFG="$LIVE_PATH/config/config.json"
if [ ! -f "$CFG" ]; then
  echo "Missing $CFG — cannot dump DB"
  exit 1
fi
DB_JSON="$(pick_laundry_db "$CFG")"
DB_HOST="$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.host||'127.0.0.1')" "$DB_JSON")"
DB_PORT="$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(String(c.port||3306))" "$DB_JSON")"
DB_USER="$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.username)" "$DB_JSON")"
DB_NAME="$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.database)" "$DB_JSON")"
DB_PASS="$(node -e "const c=JSON.parse(process.argv[1]); process.stdout.write(c.password==null?'':String(c.password))" "$DB_JSON")"
echo "DB dump target host=$DB_HOST port=$DB_PORT user=$DB_USER db=$DB_NAME"
rm -f "${DB_BACKUP_FILE%.gz}" "$DB_BACKUP_FILE"
MYSQL_PWD="$DB_PASS" mysqldump \
  -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
  --single-transaction --routines --triggers --events \
  "$DB_NAME" | gzip -c > "$DB_BACKUP_FILE"
test -s "$DB_BACKUP_FILE"
chmod 600 "$DB_BACKUP_FILE"
ls -lh "$DB_BACKUP_FILE"

DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$RELEASE_PATH/release.json" <<EOF
{
  "app": "laundry-api",
  "commit": "$RELEASE_ID",
  "shortCommit": "$(printf '%s' "$RELEASE_ID" | cut -c1-8)",
  "branch": "${GITHUB_REF_NAME:-}",
  "releaseName": "$RELEASE_NAME",
  "deployedBy": "${GITHUB_ACTOR:-}",
  "runId": "${GITHUB_RUN_ID:-}",
  "runNumber": "${GITHUB_RUN_NUMBER:-$RUN_NUMBER}",
  "packagedAt": "${PACKAGED_AT:-}",
  "deployedAt": "$DEPLOYED_AT",
  "pm2App": "$PM2_APP_NAME",
  "livePath": "$LIVE_PATH",
  "deployRoot": "$DEPLOY_ROOT",
  "appUrl": "$APP_URL",
  "fileBackup": "$(basename "$BACKUP_FILE")",
  "dbBackup": "$(basename "$DB_BACKUP_FILE")"
}
EOF
# Keep text twin in sync with final deploy clock
cat > "$RELEASE_PATH/release-info.txt" <<EOF
$RELEASE_NAME
commit=$RELEASE_ID
branch=${GITHUB_REF_NAME:-}
run=${RUN_NUMBER}
runId=${GITHUB_RUN_ID:-}
actor=${GITHUB_ACTOR:-}
deployed_at_utc=$DEPLOYED_AT
pm2=$PM2_APP_NAME
livePath=$LIVE_PATH
deployRoot=$DEPLOY_ROOT
file_backup=$(basename "$BACKUP_FILE")
db_backup=$(basename "$DB_BACKUP_FILE")
EOF

echo "Syncing release to live (preserving secrets/uploads/Public)..."
rsync -az --delete \
  --exclude=".env" \
  --exclude=".env.*" \
  --exclude=".htaccess" \
  --exclude=".well-known" \
  --exclude="uploads" \
  --exclude="Public" \
  --exclude="node_modules" \
  --exclude="config/config.json" \
  --exclude="firebase.json" \
  --exclude="backups" \
  --exclude="*.pem" \
  --exclude="*.key" \
  "$RELEASE_PATH/" "$LIVE_PATH/"

cd "$LIVE_PATH"
ensure_node20

echo "Installing dependencies..."
npm ci --include=dev || npm install

echo "Running migrations..."
# Prefer the Sequelize env that matches THIS live path / .env DB
# (never blindly pick `development` — that migrates stage while prod stays behind).
MIGRATE_ENV="$(
  LIVE_PATH="$LIVE_PATH" \
  PM2_APP_NAME="$PM2_APP_NAME" \
  APP_URL="$APP_URL" \
  node "$LIVE_PATH/scripts/pick-sequelize-migrate-env.js" 2>/dev/null || true
)"
MIGRATE_ENV="${MIGRATE_ENV:-development}"
echo "sequelize migrate --env $MIGRATE_ENV (live=$LIVE_PATH pm2=$PM2_APP_NAME)"
set +e
npx sequelize-cli db:migrate --env "$MIGRATE_ENV" 2>&1 | tee "$DEPLOY_ROOT/logs/last-migrate-deploy.log"
MIGRATE_EXIT=${PIPESTATUS[0]}
set -e

# Apply ALL pending + idempotent-heal migrations on the LIVE database
# (config.json env can still point sequelize-cli at the wrong DB).
if [ -f "$LIVE_PATH/scripts/ensure-live-migrations.js" ]; then
  echo "Ensuring ALL migrations on live DB..."
  set +e
  LIVE_PATH="$LIVE_PATH" PM2_APP_NAME="$PM2_APP_NAME" APP_URL="$APP_URL" \
    SEQUELIZE_ENV="$MIGRATE_ENV" \
    node "$LIVE_PATH/scripts/ensure-live-migrations.js" 2>&1 | tee -a "$DEPLOY_ROOT/logs/last-migrate-deploy.log"
  set -e
fi

# Self-heal repair catalog schema against the live .env DB even if meta drifted.
if [ -f "$LIVE_PATH/scripts/ensure-repair-catalog-schema.js" ]; then
  echo "Ensuring repair catalog schema on live DB..."
  set +e
  LIVE_PATH="$LIVE_PATH" PM2_APP_NAME="$PM2_APP_NAME" APP_URL="$APP_URL" \
    SEQUELIZE_ENV="$MIGRATE_ENV" \
    node "$LIVE_PATH/scripts/ensure-repair-catalog-schema.js" 2>&1 | tee -a "$DEPLOY_ROOT/logs/last-migrate-deploy.log"
  set -e
fi

if [ -f "$LIVE_PATH/scripts/ensure-invoice-auto-charge-schema.js" ]; then
  echo "Ensuring invoice auto-charge columns on live DB..."
  set +e
  LIVE_PATH="$LIVE_PATH" PM2_APP_NAME="$PM2_APP_NAME" APP_URL="$APP_URL" \
    SEQUELIZE_ENV="$MIGRATE_ENV" \
    node "$LIVE_PATH/scripts/ensure-invoice-auto-charge-schema.js" 2>&1 | tee -a "$DEPLOY_ROOT/logs/last-migrate-deploy.log"
  set -e
fi

MIGRATE_TAIL="$(tail -n 40 "$DEPLOY_ROOT/logs/last-migrate-deploy.log" 2>/dev/null | tr '\n' ' ' | tr -d '\r' | sed 's/"/\\"/g' | cut -c1-900 || true)"
MIGRATE_SUMMARY="$(grep -E 'No migrations were executed|migrated|== [0-9].*: migrated|ERROR|Error' "$DEPLOY_ROOT/logs/last-migrate-deploy.log" 2>/dev/null | tail -n 8 | tr '\n' ' | ' | tr -d '\r' | sed 's/"/\\"/g' | cut -c1-500 || true)"

echo "Running deploy seeds (non-fatal)..."
SEED_EXIT=0
if [ -x "$LIVE_PATH/scripts/run-deploy-seeds.sh" ]; then
  set +e
  bash "$LIVE_PATH/scripts/run-deploy-seeds.sh" "$LIVE_PATH" 2>&1 | tee "$DEPLOY_ROOT/logs/last-seed.log"
  SEED_EXIT=${PIPESTATUS[0]}
  set -e
  if [ "$SEED_EXIT" -ne 0 ]; then
    echo "WARN: seeds failed — continuing"
  fi
else
  echo "WARN: run-deploy-seeds.sh missing"
  SEED_EXIT=1
fi
SEED_SUMMARY="$(grep -E 'seed|Seed|Validation error|ERROR|Error|done|OK' "$DEPLOY_ROOT/logs/last-seed.log" 2>/dev/null | tail -n 10 | tr '\n' ' | ' | tr -d '\r' | sed 's/"/\\"/g' | cut -c1-500 || true)"

# Persist migrate/seed fingerprint into live release.json (readable via /health/deploy)
export LIVE_PATH MIGRATE_ENV
export MIGRATE_EXIT MIGRATE_SUMMARY MIGRATE_TAIL
export SEED_EXIT SEED_SUMMARY
node <<'EOF'
const fs = require('fs');
const p = (process.env.LIVE_PATH || '') + '/release.json';
let j = {};
try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
j.migrate = {
  env: process.env.MIGRATE_ENV || null,
  exitCode: Number(process.env.MIGRATE_EXIT || 0),
  ok: Number(process.env.MIGRATE_EXIT || 0) === 0,
  summary: process.env.MIGRATE_SUMMARY || null,
  logTail: process.env.MIGRATE_TAIL || null,
  at: new Date().toISOString()
};
j.seed = {
  exitCode: Number(process.env.SEED_EXIT || 0),
  ok: Number(process.env.SEED_EXIT || 0) === 0,
  summary: process.env.SEED_SUMMARY || null,
  at: new Date().toISOString()
};
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
EOF

if [ "$MIGRATE_EXIT" -ne 0 ]; then
  echo "ERROR: db:migrate failed (exit $MIGRATE_EXIT) — see $DEPLOY_ROOT/logs/last-migrate-deploy.log"
  exit "$MIGRATE_EXIT"
fi

# Sync ops control token (optional). Enables /ops/* from CI / local agents without SSH.
# Prefer GitHub secret OPS_CONTROL_TOKEN passed into this script's environment.
if [ -n "${OPS_CONTROL_TOKEN:-}" ]; then
  echo "Writing ops control token file + upserting .env OPS_CONTROL_TOKEN..."
  printf '%s' "$OPS_CONTROL_TOKEN" > "$LIVE_PATH/.ops-control-token"
  chmod 600 "$LIVE_PATH/.ops-control-token"
  if [ -f "$LIVE_PATH/.env" ]; then
    if grep -q '^OPS_CONTROL_TOKEN=' "$LIVE_PATH/.env"; then
      # portable in-place replace without leaking token into process list via sed -i backup
      awk -v tok="$OPS_CONTROL_TOKEN" '
        BEGIN { done=0 }
        /^OPS_CONTROL_TOKEN=/ {
          print "OPS_CONTROL_TOKEN=" tok
          done=1
          next
        }
        { print }
        END { if (!done) print "OPS_CONTROL_TOKEN=" tok }
      ' "$LIVE_PATH/.env" > "$LIVE_PATH/.env.ops-tmp" && mv "$LIVE_PATH/.env.ops-tmp" "$LIVE_PATH/.env"
      chmod 600 "$LIVE_PATH/.env" 2>/dev/null || true
    else
      printf '\nOPS_CONTROL_TOKEN=%s\n' "$OPS_CONTROL_TOKEN" >> "$LIVE_PATH/.env"
    fi
  else
    printf 'OPS_CONTROL_TOKEN=%s\n' "$OPS_CONTROL_TOKEN" > "$LIVE_PATH/.env"
    chmod 600 "$LIVE_PATH/.env"
  fi
else
  echo "OPS_CONTROL_TOKEN not set in deploy env — /ops stays disabled unless already on server"
fi

echo "Reloading PM2..."
if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  pm2 reload "$PM2_APP_NAME" --update-env
else
  pm2 start "$LIVE_PATH/laundary.js" --name "$PM2_APP_NAME" --cwd "$LIVE_PATH" --update-env
fi
pm2 save

echo "$RELEASE_NAME" > "$DEPLOY_ROOT/current-release.txt"
cp -f "$LIVE_PATH/release.json" "$DEPLOY_ROOT/current-release.json" 2>/dev/null || true
{
  echo "release_name=$RELEASE_NAME"
  echo "commit=$RELEASE_ID"
  echo "file_backup=$BACKUP_FILE"
  echo "db_backup=$DB_BACKUP_FILE"
  echo "pm2=$PM2_APP_NAME"
  echo "actor=${GITHUB_ACTOR:-}"
  echo "date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "---"
} >> "$DEPLOY_LOG"

echo "Smoke check $APP_URL/health ..."
HTTP_CODE="000"
for ATTEMPT in $(seq 1 12); do
  HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$APP_URL/health" || echo 000)"
  echo "attempt $ATTEMPT /health HTTP=$HTTP_CODE"
  if [ "$HTTP_CODE" = "200" ]; then
    break
  fi
  sleep 5
done
if [ "$HTTP_CODE" != "200" ]; then
  echo "Smoke check failed: /health returned HTTP=$HTTP_CODE"
  exit 1
fi

echo "Smoke check $APP_URL/health/deploy (expect commit $RELEASE_ID) ..."
DEPLOY_BODY="$(curl -sS --max-time 20 "$APP_URL/health/deploy" || true)"
echo "$DEPLOY_BODY" | head -c 800; echo
SHORT="$(printf '%s' "$RELEASE_ID" | cut -c1-8)"
if ! printf '%s' "$DEPLOY_BODY" | grep -q "$SHORT"; then
  echo "Smoke check failed: /health/deploy missing commit $SHORT"
  exit 1
fi
echo "Deploy fingerprint OK ($SHORT)"

# Keep last 10
ls -1dt "$DEPLOY_ROOT/releases"/* 2>/dev/null | tail -n +11 | xargs -r rm -rf
ls -1t "$DEPLOY_ROOT/backups"/file-before-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
ls -1t "$DEPLOY_ROOT/db-backups"/db-before-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f

trap - ERR
echo "DEPLOY COMPLETE $RELEASE_NAME"
echo "file_backup=$BACKUP_FILE"
echo "db_backup=$DB_BACKUP_FILE"

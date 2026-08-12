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
actor=${GITHUB_ACTOR:-}
deployed_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
file_backup=$(basename "$BACKUP_FILE")
db_backup=$(basename "$DB_BACKUP_FILE")
EOF

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
# Prefer laundry-bearing Sequelize env (often `development` on this VPS).
MIGRATE_ENV="$(node <<'JS'
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('config/config.json', 'utf8'));
function ph(c){return !c||!c.database||!c.username||/^your_/i.test(c.database);}
function laundry(c){const t=(c.database+' '+(c.username||'')).toLowerCase();return /laund/.test(t)&&!/fomino/.test(t);}
for (const k of ['development','production','test']) {
  if (raw[k] && !ph(raw[k]) && laundry(raw[k])) { process.stdout.write(k); process.exit(0); }
}
process.stdout.write('development');
JS
)"
echo "sequelize migrate --env $MIGRATE_ENV"
npx sequelize-cli db:migrate --env "$MIGRATE_ENV" 2>&1 | tee "$DEPLOY_ROOT/logs/last-migrate-deploy.log"


echo "Running deploy seeds (non-fatal)..."
if [ -x "$LIVE_PATH/scripts/run-deploy-seeds.sh" ]; then
  bash "$LIVE_PATH/scripts/run-deploy-seeds.sh" "$LIVE_PATH" 2>&1 | tee "$DEPLOY_ROOT/logs/last-seed.log" || \
    echo "WARN: seeds failed — continuing"
else
  echo "WARN: run-deploy-seeds.sh missing"
fi

echo "Reloading PM2..."
if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  pm2 reload "$PM2_APP_NAME" --update-env
else
  pm2 start "$LIVE_PATH/laundary.js" --name "$PM2_APP_NAME" --cwd "$LIVE_PATH" --update-env
fi
pm2 save

echo "$RELEASE_NAME" > "$DEPLOY_ROOT/current-release.txt"
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

echo "Smoke check $APP_URL ..."
HTTP_CODE="000"
for ATTEMPT in $(seq 1 12); do
  HTTP_CODE="$(curl -sS -L -I --max-time 20 "$APP_URL" | awk 'NR==1 {print $2}' || echo 000)"
  echo "attempt $ATTEMPT HTTP=$HTTP_CODE"
  if [ "$HTTP_CODE" != "000" ] && [ "$HTTP_CODE" -lt 500 ]; then
    break
  fi
  sleep 5
done
if [ "$HTTP_CODE" = "000" ] || [ "$HTTP_CODE" -ge 500 ]; then
  echo "Smoke check failed"
  exit 1
fi

# Keep last 10
ls -1dt "$DEPLOY_ROOT/releases"/* 2>/dev/null | tail -n +11 | xargs -r rm -rf
ls -1t "$DEPLOY_ROOT/backups"/file-before-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
ls -1t "$DEPLOY_ROOT/db-backups"/db-before-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f

trap - ERR
echo "DEPLOY COMPLETE $RELEASE_NAME"
echo "file_backup=$BACKUP_FILE"
echo "db_backup=$DB_BACKUP_FILE"

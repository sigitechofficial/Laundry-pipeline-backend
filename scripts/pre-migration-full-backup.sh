#!/usr/bin/env bash
# Full pre-migration snapshot: stage + prod application code + MySQL dumps.
# Safe / read-only against live apps (does not stop PM2, does not overwrite DBs).
#
# Usage (on VPS as sigisolutions):
#   bash /path/to/pre-migration-full-backup.sh
#
# Optional env:
#   BACKUP_ROOT  default /home/sigisolutions/deployments/laundry-pre-migration-backups
#   PROD_ROOT    default /home/sigisolutions/prodlaundry.sigisolutions.net
#   STAGE_ROOT   default /home/sigisolutions/stagelaundry.sigisolutions.net
#   ADMIN_ROOTS  space-separated extra dirs to tar if they exist
set -euo pipefail

export HOME="${HOME:-/home/sigisolutions}"
PROD_ROOT="${PROD_ROOT:-/home/sigisolutions/prodlaundry.sigisolutions.net}"
STAGE_ROOT="${STAGE_ROOT:-/home/sigisolutions/stagelaundry.sigisolutions.net}"
BACKUP_ROOT="${BACKUP_ROOT:-/home/sigisolutions/deployments/laundry-pre-migration-backups}"
ADMIN_ROOTS="${ADMIN_ROOTS:-/home/sigisolutions/laundryadmin.sigisolutions.net /home/sigisolutions/stagelaundryadmin.sigisolutions.net /home/sigisolutions/adminlaundry.sigisolutions.net}"

TS="$(date -u +%Y%m%d-%H%M%SZ)"
OUT="$BACKUP_ROOT/$TS"
mkdir -p "$OUT/code" "$OUT/db" "$OUT/logs"

MANIFEST="$OUT/MANIFEST.txt"
exec > >(tee -a "$OUT/logs/backup.log") 2>&1

echo "========================================"
echo "Laundry pre-migration full backup"
echo "UTC: $TS"
echo "Output: $OUT"
echo "========================================"

{
  echo "backup_id=$TS"
  echo "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host=$(hostname -f 2>/dev/null || hostname)"
  echo "user=$(whoami)"
  echo "prod_root=$PROD_ROOT"
  echo "stage_root=$STAGE_ROOT"
  echo "---"
} > "$MANIFEST"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1"
    exit 1
  fi
}

need_cmd tar
need_cmd mysqldump
need_cmd node
need_cmd df

echo "Disk space before backup:"
df -h "$BACKUP_ROOT" 2>/dev/null || df -h /home/sigisolutions || df -h

FREE_KB="$(df -Pk "$BACKUP_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "${FREE_KB:-}" ] && [ "$FREE_KB" -lt 2097152 ]; then
  echo "ERROR: less than ~2GB free under backup volume (${FREE_KB}KB). Free disk, then re-run."
  exit 1
fi

tar_app() {
  local label="$1"
  local src="$2"
  local dest="$3"

  if [ ! -d "$src" ]; then
    echo "SKIP code/$label — path missing: $src"
    echo "code_${label}=MISSING:$src" >> "$MANIFEST"
    return 0
  fi

  echo "Creating code backup: $label from $src"
  tar \
    --exclude='./node_modules' \
    --exclude='./.git' \
    --exclude='./uploads' \
    --exclude='./backups' \
    --exclude='./coverage' \
    --exclude='./tmp' \
    --exclude='./temp' \
    --exclude='./*.log' \
    --exclude='./logs' \
    --exclude='./*.tar.gz' \
    --exclude='./*.zip' \
    -czf "$dest" \
    -C "$src" .

  if [ ! -s "$dest" ]; then
    echo "ERROR: empty archive $dest"
    exit 1
  fi

  local size
  size="$(du -h "$dest" | awk '{print $1}')"
  local sha
  sha="$(sha256sum "$dest" | awk '{print $1}')"
  chmod 600 "$dest"
  echo "OK $dest ($size) sha256=$sha"
  echo "code_${label}=$dest size=$size sha256=$sha" >> "$MANIFEST"
}

# --- Code snapshots ---
tar_app "prod-backend" "$PROD_ROOT" "$OUT/code/prod-backend.tar.gz"
tar_app "stage-backend" "$STAGE_ROOT" "$OUT/code/stage-backend.tar.gz"

for admin_path in $ADMIN_ROOTS; do
  label="$(basename "$admin_path" | tr '.' '-')"
  tar_app "admin-$label" "$admin_path" "$OUT/code/admin-${label}.tar.gz"
done

# Also snapshot any laundry* docroots under home (best-effort discovery)
echo "Discovering other laundry* paths under /home/sigisolutions ..."
while IFS= read -r path; do
  case "$path" in
    "$PROD_ROOT"|"$STAGE_ROOT") continue ;;
  esac
  for known in $ADMIN_ROOTS; do
    if [ "$path" = "$known" ]; then
      continue 2
    fi
  done
  label="$(basename "$path" | tr '.' '-')"
  tar_app "extra-$label" "$path" "$OUT/code/extra-${label}.tar.gz"
done < <(ls -1d /home/sigisolutions/*laundry* 2>/dev/null || true)

dump_db_from_config() {
  local label="$1"
  local config_path="$2"
  local out_sql="$3"
  local require_laundry="${4:-1}"

  if [ ! -f "$config_path" ]; then
    echo "SKIP db/$label — config missing: $config_path"
    echo "db_${label}=MISSING_CONFIG:$config_path" >> "$MANIFEST"
    return 1
  fi

  echo "Dumping MySQL for $label using $config_path"
  if ! node <<JS
const fs = require('fs');
const { spawnSync } = require('child_process');

function isPlaceholder(cfg) {
  const db = String((cfg && cfg.database) || '');
  const user = String((cfg && cfg.username) || '');
  return /^your_/i.test(db) || /^your_/i.test(user) || !db || !user;
}

function isLaundry(cfg) {
  // Project historically uses "laundary" (typo) as well as "laundry".
  const text = (String(cfg.database || '') + ' ' + String(cfg.username || '')).toLowerCase();
  if (/fomino/.test(text)) return false;
  return /laund/.test(text);
}

function summarize(raw) {
  const out = [];
  if (raw && raw.database) {
    out.push({ key: '(root)', database: raw.database, username: raw.username });
  }
  Object.keys(raw || {}).forEach((k) => {
    const c = raw[k];
    if (c && typeof c === 'object' && c.database) {
      out.push({ key: k, database: c.database, username: c.username });
    }
  });
  return out;
}

function pick(raw, requireLaundry) {
  const preferred = ['production', 'development', 'test'];
  const entries = [];
  if (raw && raw.database && raw.username) {
    entries.push({ key: '(root)', cfg: raw });
  }
  Object.keys(raw || {}).forEach((k) => {
    const c = raw[k];
    if (c && typeof c === 'object' && c.database) entries.push({ key: k, cfg: c });
  });

  const laundry = entries.filter((e) => !isPlaceholder(e.cfg) && isLaundry(e.cfg));
  for (const k of preferred) {
    const hit = laundry.find((e) => e.key === k);
    if (hit) return Object.assign({ _pickedKey: hit.key }, hit.cfg);
  }
  if (laundry.length) return Object.assign({ _pickedKey: laundry[0].key }, laundry[0].cfg);

  if (requireLaundry) {
    throw new Error(
      'No laundry DB credentials in config (refusing non-laundry fallback). Available: ' +
        JSON.stringify(summarize(raw))
    );
  }

  for (const k of preferred) {
    const e = entries.find((x) => x.key === k && !isPlaceholder(x.cfg));
    if (e) return Object.assign({ _pickedKey: e.key }, e.cfg);
  }
  if (entries.length && !isPlaceholder(entries[0].cfg)) {
    return Object.assign({ _pickedKey: entries[0].key }, entries[0].cfg);
  }
  throw new Error('No usable DB config in $config_path');
}

const requireLaundry = process.env.REQUIRE_LAUNDRY !== '0';
const raw = JSON.parse(fs.readFileSync('$config_path', 'utf8'));
console.log('Config candidates:', JSON.stringify(summarize(raw)));
const cfg = pick(raw, requireLaundry);
const host = cfg.host || '127.0.0.1';
const port = String(cfg.port || 3306);
const user = cfg.username;
const pass = cfg.password == null ? '' : String(cfg.password);
const database = cfg.database;

console.log('DB target:', {
  label: '$label',
  pickedKey: cfg._pickedKey,
  host,
  port,
  user,
  database,
  password: 'hidden',
});

if (/fomino/i.test(user + database)) {
  console.error('Refusing to dump non-laundry (fomino) database for laundry backup');
  process.exit(2);
}

function runDump(args) {
  const out = fs.openSync('$out_sql', 'w');
  const r = spawnSync('mysqldump', args, {
    env: Object.assign({}, process.env, { MYSQL_PWD: pass }),
    stdio: ['ignore', out, 'pipe'],
    encoding: 'utf8',
  });
  fs.closeSync(out);
  return r;
}

// MariaDB-friendly flags first (no set-gtid-purged / column-statistics)
let r = runDump([
  '-h', host,
  '-P', port,
  '-u', user,
  '--single-transaction',
  '--routines',
  '--triggers',
  '--events',
  database,
]);

if (r.status !== 0) {
  console.warn('mysqldump first attempt failed:', (r.stderr || '').slice(0, 500));
  r = runDump([
    '-h', host,
    '-P', port,
    '-u', user,
    '--single-transaction',
    database,
  ]);
  if (r.status !== 0) {
    console.error(r.stderr || 'mysqldump failed');
    process.exit(r.status || 1);
  }
}

const st = fs.statSync('$out_sql');
if (!st.size) {
  console.error('Dump file is empty');
  process.exit(1);
}
console.log('Dump bytes:', st.size);
JS
  then
    :
  else
    echo "ERROR: mysqldump/node failed for $label ($config_path)"
    return 1
  fi

  if [ ! -s "$out_sql" ]; then
    echo "ERROR: dump sql missing/empty for $label"
    return 1
  fi

  gzip -f "$out_sql"
  local gz="${out_sql}.gz"
  if [ ! -s "$gz" ]; then
    echo "ERROR: empty dump $gz"
    return 1
  fi
  chmod 600 "$gz"
  local size sha
  size="$(du -h "$gz" | awk '{print $1}')"
  sha="$(sha256sum "$gz" | awk '{print $1}')"
  echo "OK $gz ($size) sha256=$sha"
  echo "db_${label}=$gz size=$size sha256=$sha" >> "$MANIFEST"
  return 0
}

# Prefer explicit laundry env vars on the server when config.json is polluted (e.g. fomino).
dump_db_from_env_file() {
  local label="$1"
  local env_path="$2"
  local out_sql="$3"

  if [ ! -f "$env_path" ]; then
    return 1
  fi

  echo "Trying DB dump for $label from env file $env_path"
  node <<JS
const fs = require('fs');
const { spawnSync } = require('child_process');
const text = fs.readFileSync('$env_path', 'utf8');
const env = {};
for (const line of text.split(/\\r?\\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  let k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  env[k] = v;
}

function pick() {
  const database =
    env.DB_NAME || env.MYSQL_DATABASE || env.DATABASE_NAME || env.DB_DATABASE || '';
  const user =
    env.DB_USER || env.MYSQL_USER || env.DATABASE_USER || env.DB_USERNAME || '';
  const pass =
    env.DB_PASSWORD || env.MYSQL_PASSWORD || env.DATABASE_PASSWORD || env.DB_PASS || '';
  const host =
    env.DB_HOST || env.MYSQL_HOST || env.DATABASE_HOST || '127.0.0.1';
  const port =
    env.DB_PORT || env.MYSQL_PORT || env.DATABASE_PORT || '3306';
  return { database, user, pass, host, port };
}

const cfg = pick();
const textId = (cfg.database + ' ' + cfg.user).toLowerCase();
console.log('Env DB candidate:', {
  label: '$label',
  host: cfg.host,
  port: cfg.port,
  user: cfg.user || '(empty)',
  database: cfg.database || '(empty)',
  password: 'hidden',
});
if (!cfg.database || !cfg.user) process.exit(3);
if (/fomino/.test(textId)) {
  console.error('Env DB looks like fomino — skipping');
  process.exit(4);
}
if (!/laund/.test(textId)) {
  console.error('Env DB does not look like laundry — skipping');
  process.exit(5);
}

function runDump(args) {
  const out = fs.openSync('$out_sql', 'w');
  const r = spawnSync('mysqldump', args, {
    env: Object.assign({}, process.env, { MYSQL_PWD: cfg.pass }),
    stdio: ['ignore', out, 'pipe'],
    encoding: 'utf8',
  });
  fs.closeSync(out);
  return r;
}

let r = runDump([
  '-h', cfg.host,
  '-P', String(cfg.port),
  '-u', cfg.user,
  '--single-transaction',
  '--routines',
  '--triggers',
  '--events',
  cfg.database,
]);
if (r.status !== 0) {
  console.warn((r.stderr || '').slice(0, 500));
  r = runDump([
    '-h', cfg.host,
    '-P', String(cfg.port),
    '-u', cfg.user,
    '--single-transaction',
    cfg.database,
  ]);
}
if (r.status !== 0) {
  console.error(r.stderr || 'mysqldump failed');
  process.exit(r.status || 1);
}
const st = fs.statSync('$out_sql');
if (!st.size) process.exit(1);
console.log('Dump bytes:', st.size);
JS

  gzip -f "$out_sql"
  local gz="${out_sql}.gz"
  [ -s "$gz" ] || return 1
  chmod 600 "$gz"
  local size sha
  size="$(du -h "$gz" | awk '{print $1}')"
  sha="$(sha256sum "$gz" | awk '{print $1}')"
  echo "OK $gz ($size) sha256=$sha"
  echo "db_${label}=$gz size=$size sha256=$sha source=env:$env_path" >> "$MANIFEST"
  return 0
}

# --- Database dumps (laundry credentials only; never fall back to fomino) ---
DB_OK=1
export REQUIRE_LAUNDRY=1

dump_prod() {
  dump_db_from_config "prod" "$PROD_ROOT/config/config.json" "$OUT/db/prod.sql" && return 0
  [ -f "$STAGE_ROOT/config/config.prod.sync.json" ] && \
    dump_db_from_config "prod" "$STAGE_ROOT/config/config.prod.sync.json" "$OUT/db/prod.sql" && return 0
  [ -f "$PROD_ROOT/config/config.production.json" ] && \
    dump_db_from_config "prod" "$PROD_ROOT/config/config.production.json" "$OUT/db/prod.sql" && return 0
  dump_db_from_env_file "prod" "$PROD_ROOT/.env" "$OUT/db/prod.sql" && return 0
  return 1
}

dump_stage() {
  dump_db_from_config "stage" "$STAGE_ROOT/config/config.json" "$OUT/db/stage.sql" && return 0
  dump_db_from_env_file "stage" "$STAGE_ROOT/.env" "$OUT/db/stage.sql" && return 0
  return 1
}

if ! dump_prod; then
  echo "ERROR: could not dump prod laundry database"
  echo "db_prod=FAILED" >> "$MANIFEST"
  DB_OK=0
fi

if ! dump_stage; then
  echo "ERROR: could not dump stage laundry database"
  echo "db_stage=FAILED" >> "$MANIFEST"
  DB_OK=0
fi

# Extra copy of prod via sync config when present (best-effort)
if [ -f "$STAGE_ROOT/config/config.prod.sync.json" ]; then
  dump_db_from_config "prod-via-stage-sync-config" "$STAGE_ROOT/config/config.prod.sync.json" "$OUT/db/prod-via-stage-sync-config.sql" || true
fi

if [ "$DB_OK" -ne 1 ]; then
  echo "ERROR: one or more laundry DB dumps failed. Code archives above are still kept."
  echo "Inspect config candidates in the log; fix laundry credentials in config.json, then re-run."
  exit 1
fi

echo "---" >> "$MANIFEST"
echo "pm2_list:" >> "$MANIFEST"
(pm2 list 2>/dev/null || true) >> "$MANIFEST"
echo "---" >> "$MANIFEST"
echo "listing:" >> "$MANIFEST"
(find "$OUT" -type f -printf '%p %s\n' 2>/dev/null || find "$OUT" -type f -exec ls -l {} \;) >> "$MANIFEST"

# Pointer to latest successful backup
echo "$TS" > "$BACKUP_ROOT/LATEST.txt"
ln -sfn "$OUT" "$BACKUP_ROOT/latest"

echo "========================================"
echo "BACKUP COMPLETE"
echo "Folder: $OUT"
echo "Manifest: $MANIFEST"
echo "Latest pointer: $BACKUP_ROOT/LATEST.txt"
echo "========================================"
cat "$MANIFEST"
echo "RESTORE HINTS:"
echo "  Code:  tar -xzf $OUT/code/prod-backend.tar.gz -C $PROD_ROOT"
echo "  Code:  tar -xzf $OUT/code/stage-backend.tar.gz -C $STAGE_ROOT"
echo "  DB:    gunzip -c $OUT/db/prod.sql.gz | mysql -u... -p... DBNAME"
echo "  DB:    gunzip -c $OUT/db/stage.sql.gz | mysql -u... -p... DBNAME"
)

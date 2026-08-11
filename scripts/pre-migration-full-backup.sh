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

  if [ ! -f "$config_path" ]; then
    echo "SKIP db/$label — config missing: $config_path"
    echo "db_${label}=MISSING_CONFIG:$config_path" >> "$MANIFEST"
    return 0
  fi

  echo "Dumping MySQL for $label using $config_path"
  node <<JS
const fs = require('fs');
const { spawnSync } = require('child_process');

function isPlaceholder(cfg) {
  const db = String((cfg && cfg.database) || '');
  const user = String((cfg && cfg.username) || '');
  return /^your_/i.test(db) || /^your_/i.test(user);
}

function pick(raw) {
  const preferred = ['production', 'development', 'test'];
  const laundryKeys = Object.keys(raw).filter((k) => {
    const c = raw[k];
    return c && c.database && !isPlaceholder(c) && (/laundr/i.test(String(c.database)) || /laundr/i.test(String(c.username || '')));
  });
  for (const k of preferred) {
    if (laundryKeys.includes(k)) return raw[k];
  }
  if (laundryKeys.length) return raw[laundryKeys[0]];
  for (const k of preferred) {
    if (raw[k] && raw[k].database && !isPlaceholder(raw[k])) return raw[k];
  }
  if (raw.database && raw.username && !isPlaceholder(raw)) return raw;
  throw new Error('No usable DB config in $config_path');
}

const raw = JSON.parse(fs.readFileSync('$config_path', 'utf8'));
const cfg = pick(raw);
const host = cfg.host || '127.0.0.1';
const port = String(cfg.port || 3306);
const user = cfg.username;
const pass = cfg.password == null ? '' : String(cfg.password);
const database = cfg.database;

console.log('DB target:', { label: '$label', host, port, user, database, password: 'hidden' });

const args = [
  '-h', host,
  '-P', port,
  '-u', user,
  '--single-transaction',
  '--routines',
  '--triggers',
  '--events',
  '--set-gtid-purged=OFF',
  '--column-statistics=0',
  database,
];

const env = Object.assign({}, process.env, { MYSQL_PWD: pass });
const out = fs.openSync('$out_sql', 'w');
const r = spawnSync('mysqldump', args, { env, stdio: ['ignore', out, 'pipe'], encoding: 'utf8' });
fs.closeSync(out);

if (r.status !== 0) {
  // Retry without flags some MariaDB/MySQL builds reject
  console.warn('mysqldump first attempt failed:', (r.stderr || '').slice(0, 500));
  const args2 = [
    '-h', host,
    '-P', port,
    '-u', user,
    '--single-transaction',
    '--routines',
    '--triggers',
    database,
  ];
  const out2 = fs.openSync('$out_sql', 'w');
  const r2 = spawnSync('mysqldump', args2, { env, stdio: ['ignore', out2, 'pipe'], encoding: 'utf8' });
  fs.closeSync(out2);
  if (r2.status !== 0) {
    console.error(r2.stderr || r.stderr || 'mysqldump failed');
    process.exit(r2.status || 1);
  }
}

const st = fs.statSync('$out_sql');
if (!st.size) {
  console.error('Dump file is empty');
  process.exit(1);
}
console.log('Dump bytes:', st.size);
JS

  gzip -f "$out_sql"
  local gz="${out_sql}.gz"
  if [ ! -s "$gz" ]; then
    echo "ERROR: empty dump $gz"
    exit 1
  fi
  chmod 600 "$gz"
  local size sha
  size="$(du -h "$gz" | awk '{print $1}')"
  sha="$(sha256sum "$gz" | awk '{print $1}')"
  echo "OK $gz ($size) sha256=$sha"
  echo "db_${label}=$gz size=$size sha256=$sha" >> "$MANIFEST"
}

# --- Database dumps ---
dump_db_from_config "prod" "$PROD_ROOT/config/config.json" "$OUT/db/prod.sql"
dump_db_from_config "stage" "$STAGE_ROOT/config/config.json" "$OUT/db/stage.sql"

# If stage keeps a sync copy of prod credentials, also dump that live DB under an explicit name
if [ -f "$STAGE_ROOT/config/config.prod.sync.json" ]; then
  dump_db_from_config "prod-via-stage-sync-config" "$STAGE_ROOT/config/config.prod.sync.json" "$OUT/db/prod-via-stage-sync-config.sql" || true
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

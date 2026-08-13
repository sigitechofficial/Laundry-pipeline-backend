#!/usr/bin/env bash
# Idempotent production seeders after sequelize migrate on deploy.
# Only reference/catalog data — never demo users/orders.
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

MIGRATE_ENV="${SEQUELIZE_ENV:-}"
if [ -z "$MIGRATE_ENV" ] && [ -f scripts/pick-sequelize-migrate-env.js ]; then
  MIGRATE_ENV="$(node scripts/pick-sequelize-migrate-env.js 2>/dev/null || true)"
fi
if [ -z "$MIGRATE_ENV" ] && [ -f config/config.json ]; then
  MIGRATE_ENV="$(node <<'JS'
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('config/config.json', 'utf8'));
function ph(c){return !c||!c.database||!c.username||/^your_/i.test(c.database);}
function laundry(c){const t=(c.database+' '+(c.username||'')).toLowerCase();return /laund/.test(t)&&!/fomino/.test(t);}
for (const k of ['production','development','test']) {
  if (raw[k] && !ph(raw[k]) && laundry(raw[k])) { process.stdout.write(k); process.exit(0); }
}
process.stdout.write('development');
JS
)"
fi
MIGRATE_ENV="${MIGRATE_ENV:-development}"
echo ">>> [deploy-seed] env=$MIGRATE_ENV"

# Repair tables must exist before catalog seed (prod previously skipped migrate).
if [ -f scripts/ensure-repair-catalog-schema.js ]; then
  echo ">>> ensure scripts/ensure-repair-catalog-schema.js"
  SEQUELIZE_ENV="$MIGRATE_ENV" node scripts/ensure-repair-catalog-schema.js || echo "WARN: ensure-repair-catalog-schema failed (non-fatal)"
fi

run_one() {
  local file="$1"
  if [ ! -f "seeders/$file" ]; then
    echo "SKIP missing seeder: $file"
    return 0
  fi
  echo ">>> seeding $file"
  npx sequelize-cli db:seed --env "$MIGRATE_ENV" --seed "$file" || {
    echo "WARN: seeder failed (non-fatal): $file"
    return 0
  }
}

# Order matters for FKs / lookups
run_one "20250121073345-userType.js"
run_one "20250123063512-bookingStatuses.js"
run_one "20250129112615-units.js"
run_one "20250129113626-appUnits.js"
run_one "20250129114116-baseunits.js"
run_one "20250414052723-roles.js"
run_one "20250414060150-classifiedAs.js"
run_one "20260520130000-account-deletion-reasons.js"
run_one "20260811120000-laundry-shop-manager-role.js"
run_one "20260811181000-review-reason-codes.js"
run_one "20260811190000-shop-staff-default-permissions.js"
run_one "20260813171000-repair-catalog-defaults.js"
run_one "20260813190000-dry-clean-catalog-batch-1.js"
run_one "20260813191000-dry-clean-catalog-batch-2.js"

# Optional ensure-* scripts (no-op if already applied)
for s in \
  scripts/ensure-admin-notification-preferences.js \
  scripts/ensure-admin-push-logs.js \
  scripts/ensure-booking-notifications.js \
  scripts/ensure-booking-notifications-push-channel.js \
  scripts/ensure-booking-call-sessions.js
do
  if [ -f "$s" ]; then
    echo ">>> ensure $s"
    node "$s" || echo "WARN: ensure script failed (non-fatal): $s"
  fi
done

echo "Deploy seeders finished (warnings above are non-fatal)."

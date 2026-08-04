#!/bin/bash
set -euo pipefail
source "$HOME/.nvm/nvm.sh" 2>/dev/null || true
export HOME="${HOME:-/home/sigisolutions}"
APP_ROOT="${APP_ROOT:-/home/sigisolutions/stagelaundry.sigisolutions.net}"
cd "$APP_ROOT"
mkdir -p backups
export APP_ROOT
export PROD_CONFIG_PATH="$APP_ROOT/config/config.prod.sync.json"
export STAGE_CONFIG_PATH="$APP_ROOT/config/config.json"
export DB_BACKUP_DIR="$APP_ROOT/backups"
export DB_SYNC_STATUS_PATH="$APP_ROOT/backups/live-to-stage-sync-status.json"
node scripts/live-to-stage-db-sync.js
echo SYNC_OK
node -e "const s=require('./backups/live-to-stage-sync-status.json'); console.log(JSON.stringify({state:s.state,phase:s.phase,liveTableCount:s.liveTableCount,stageTableCount:s.stageTableCount,stageBackup:s.stageBackup,error:s.error},null,2))"

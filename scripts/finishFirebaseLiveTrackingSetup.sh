#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Re-auth Firebase CLI (browser will open)…"
firebase login --reauth

echo "==> Enable RTDB Management API…"
# Best effort via console link if gcloud missing
open "https://console.developers.google.com/apis/api/firebasedatabase.googleapis.com/overview?project=880600214434" || true

echo "==> Create RTDB instance if missing…"
cd firebase-cli
firebase database:instances:create laundry-app-bf43c-default-rtdb --location us-central1 --project laundry-app-bf43c \
  || echo "(create skipped / already exists)"

echo "==> Deploy security rules…"
firebase deploy --only database --project laundry-app-bf43c

echo "==> Verify…"
firebase database:instances:list --project laundry-app-bf43c || true

cd ..
node -e "
const fs=require('fs');
const url='https://laundry-app-bf43c-default-rtdb.firebaseio.com';
let t=fs.readFileSync('.env','utf8');
if(/FIREBASE_DATABASE_URL=/.test(t)) t=t.replace(/^FIREBASE_DATABASE_URL=.*$/m,'FIREBASE_DATABASE_URL='+url);
else t+='\nFIREBASE_DATABASE_URL='+url+'\n';
fs.writeFileSync('.env',t);
console.log('FIREBASE_DATABASE_URL set to', url);
"

echo "==> DONE. Restart backend so it picks up .env."

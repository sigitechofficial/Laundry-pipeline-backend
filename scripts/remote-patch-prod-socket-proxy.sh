#!/usr/bin/env bash
# Run ON the VPS. Backs up prod .htaccess and inserts Socket.IO WebSocket
# proxy rules before the existing [P] rewrite (Node PORT=8989).
set -euo pipefail

PROD_HT="${PROD_HT:-/home/sigisolutions/prodlaundry.sigisolutions.net/.htaccess}"
STAGE_HT="${STAGE_HT:-/home/sigisolutions/stagelaundry.sigisolutions.net/.htaccess}"

echo "===== STAGE .htaccess ====="
if [ -f "$STAGE_HT" ]; then cat "$STAGE_HT"; else echo "(missing)"; fi
echo
echo "===== PROD .htaccess (before) ====="
if [ -f "$PROD_HT" ]; then cat "$PROD_HT"; else echo "(missing)"; fi
echo

if [ ! -f "$PROD_HT" ]; then
  echo "ERROR: prod .htaccess not found at $PROD_HT"
  exit 1
fi

if grep -q 'ws://127.0.0.1:8989/socket.io' "$PROD_HT"; then
  echo "Already contains prod Socket.IO WebSocket rewrite. No change."
  exit 0
fi

TS="$(date -u +%Y%m%d%H%M%S)"
cp -a "$PROD_HT" "${PROD_HT}.bak-ws-${TS}"
echo "Backup: ${PROD_HT}.bak-ws-${TS}"

python3 - "$PROD_HT" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
block = (
    "\n# Socket.IO WebSocket — Apache must upgrade (prod was 400, stage is 101)\n"
    "RewriteCond %{HTTP:Upgrade} websocket [NC]\n"
    "RewriteCond %{HTTP:Connection} upgrade [NC]\n"
    "RewriteRule ^socket\\.io/(.*) ws://127.0.0.1:8989/socket.io/$1 [P,L]\n"
)

lines = text.splitlines(keepends=True)
insert_at = None
for i, line in enumerate(lines):
    compact = line.replace(" ", "")
    if "RewriteRule" in line and "[P" in compact:
        insert_at = i

if insert_at is None:
    if text and not text.endswith("\n"):
        text += "\n"
    text += block
else:
    lines.insert(insert_at, block if block.endswith("\n") else block + "\n")
    text = "".join(lines)

path.write_text(text)
print("Patched", path)
PY

echo
echo "===== PROD .htaccess (after) ====="
cat "$PROD_HT"
echo
echo "OK — reload not required for .htaccess (per-request)."

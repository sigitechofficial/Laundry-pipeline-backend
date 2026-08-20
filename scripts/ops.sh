#!/usr/bin/env bash
# Local ops helper — diagnose / PM2 logs / reload without cPanel or SSH.
# Usage:
#   ./scripts/ops.sh stage diagnose
#   ./scripts/ops.sh stage logs err 100
#   ./scripts/ops.sh stage logs both 200 Error
#   ./scripts/ops.sh stage status
#   ./scripts/ops.sh stage migrate
#   ./scripts/ops.sh stage reload
#   ./scripts/ops.sh prod diagnose
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_NAME="${1:-stage}"
CMD="${2:-diagnose}"

case "$ENV_NAME" in
  stage|staging)
    BASE_URL="${OPS_STAGE_URL:-https://stagelaundry.sigisolutions.net}"
    ;;
  prod|production|main)
    BASE_URL="${OPS_PROD_URL:-https://prodlaundry.sigisolutions.net}"
    ;;
  *)
    echo "Usage: $0 <stage|prod> <diagnose|status|logs|migrate|seed|deploy|reload|restart> [args...]"
    exit 1
    ;;
esac

TOKEN_FILE="${OPS_TOKEN_FILE:-$ROOT/.ops-control-token}"
if [ -z "${OPS_TOKEN:-}" ] && [ -f "$TOKEN_FILE" ]; then
  OPS_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
fi
if [ -z "${OPS_TOKEN:-}" ]; then
  echo "Missing OPS_TOKEN. Set env OPS_TOKEN or create $TOKEN_FILE"
  exit 1
fi

auth=(-H "X-Ops-Token: $OPS_TOKEN" -H "Accept: application/json")

json_get() {
  local path="$1"
  shift || true
  curl -sS --max-time 60 "${auth[@]}" "$BASE_URL$path" "$@"
}

print_json() {
  if command -v jq >/dev/null 2>&1; then
    jq .
  else
    python3 -m json.tool 2>/dev/null || cat
  fi
}

print_text_field() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.data.text // .message // .'
  else
    python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('data') or {}).get('text') or d.get('message') or '')"
  fi
}

echo "# $ENV_NAME  $BASE_URL  cmd=$CMD" >&2

case "$CMD" in
  diagnose|diag)
    LINES="${3:-120}"
    json_get "/ops/diagnose?logLines=$LINES" | print_json
    ;;
  status)
    json_get "/ops/status" | print_json
    ;;
  logs|log)
    STREAM="${3:-both}"
    LINES="${4:-200}"
    GREP="${5:-}"
    QS="lines=$LINES&stream=$STREAM"
    if [ -n "$GREP" ]; then
      QS="$QS&grep=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$GREP")"
    fi
    json_get "/ops/pm2/logs?$QS" | print_text_field
    ;;
  errors)
    LINES="${3:-150}"
    json_get "/ops/pm2/logs?lines=$LINES&stream=err" | print_text_field
    ;;
  migrate|seed|deploy)
    LINES="${3:-80}"
    json_get "/ops/deploy-logs?name=$CMD&lines=$LINES" | print_text_field
    ;;
  reload|restart)
    curl -sS --max-time 90 "${auth[@]}" -H "Content-Type: application/json" \
      -X POST -d '{"confirm":true}' \
      "$BASE_URL/ops/pm2/$CMD" | print_json
    ;;
  health)
    curl -sS --max-time 30 "$BASE_URL/health" | print_json
    echo "---" >&2
    curl -sS --max-time 30 "$BASE_URL/health/deploy" | print_json
    echo "---" >&2
    json_get "/health/schema" | print_json
    ;;
  *)
    echo "Unknown command: $CMD"
    echo "Commands: diagnose status logs errors migrate seed deploy reload restart health"
    exit 1
    ;;
esac

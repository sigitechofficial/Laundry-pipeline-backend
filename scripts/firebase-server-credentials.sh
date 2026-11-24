#!/usr/bin/env bash
# Firebase Admin credentials on the API server (runs ON the VPS). Never prints key material.
#
#   firebase-server-credentials.sh install
#     Called by remote-deploy-api.sh on every deploy. Idempotent.
#     - FIREBASE_SERVICE_ACCOUNT_FILE: path of the PRIMARY project's service-account JSON
#       (GitHub secret FIREBASE_SERVICE_ACCOUNT_JSON, scp'd by deploy-api.yml as a 600 file into
#       the 700 drop dir $DEPLOY_ROOT/secrets/firebase/incoming). Validated, written to
#       $DEPLOY_ROOT/secrets/firebase/primary.json (dir 700, file 600, atomic replace) and the
#       drop file is shredded, whether or not it was valid. The key itself never travels
#       through environment variables (they end up in process listings and PM2 dumps).
#       Not set: nothing changes (the server keeps whatever Firebase config it has).
#     - The server's existing ./firebase.json (the project the apps used before the move)
#       becomes the LEGACY credential: copied once to secrets/firebase/legacy.json when its
#       project differs from the primary's. It is copied, not moved, so a rollback to a
#       release that still reads ./firebase.json keeps working.
#     - .env: FIREBASE_CREDENTIALS_PATH, FIREBASE_DATABASE_URL (FIREBASE_DATABASE_URL_VALUE),
#       FIREBASE_LEGACY_CREDENTIALS_PATH and FIREBASE_LEGACY_DATABASE_URL (the RTDB URL the
#       server used before the move, preserved the first time; or
#       FIREBASE_LEGACY_DATABASE_URL_VALUE when given).
#
#   firebase-server-credentials.sh discard
#     Shreds the credential drop file (FIREBASE_SERVICE_ACCOUNT_FILE, if any). Called by
#     remote-deploy-api.sh on every exit path, so a failed deploy never leaves it behind.
#
#   firebase-server-credentials.sh downgrade <release-dir>
#     Called by rollbacks after restoring <release-dir> into LIVE_PATH. A release without
#     utils/firebaseProjects.js reads only ./firebase.json + FIREBASE_DATABASE_URL, so
#     FIREBASE_DATABASE_URL is pointed back at the legacy RTDB (the next deploy of a newer
#     release sets it again). No-op for releases that know both projects.
#
# Required env: LIVE_PATH, DEPLOY_ROOT.
set -euo pipefail

LIVE_PATH="${LIVE_PATH:?LIVE_PATH required}"
DEPLOY_ROOT="${DEPLOY_ROOT:?DEPLOY_ROOT required}"
ENV_FILE="$LIVE_PATH/.env"
SECRETS_DIR="$DEPLOY_ROOT/secrets/firebase"
PRIMARY="$SECRETS_DIR/primary.json"
DROP_DIR="$SECRETS_DIR/incoming"
LEGACY="$SECRETS_DIR/legacy.json"

# project_id of a service-account file ('' when unreadable). The path goes through env, never argv.
project_of() {
  SA_FILE="$1" node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(process.env.SA_FILE, "utf8"));
      process.stdout.write(typeof j.project_id === "string" ? j.project_id : "");
    } catch (e) { process.stdout.write(""); }
  '
}

# Removes the credential drop file. Only files inside the drop dir are touched.
discard_drop() {
  local f="${FIREBASE_SERVICE_ACCOUNT_FILE:-}"
  [ -n "$f" ] || return 0
  case "$f" in
    "$DROP_DIR"/*) ;;
    *) echo "[firebase] refusing to remove $f (outside $DROP_DIR)"; return 0 ;;
  esac
  [ -f "$f" ] || return 0
  if command -v shred >/dev/null 2>&1; then
    shred -u "$f" 2>/dev/null || rm -f "$f"
  else
    rm -f "$f"
  fi
}

env_get() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  awk -v k="$key" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { if (v != "") print v }' "$ENV_FILE"
}

env_set() {
  local key="$1" val="$2"
  if [ ! -f "$ENV_FILE" ]; then
    ( umask 077; printf '%s=%s\n' "$key" "$val" > "$ENV_FILE" )
    return 0
  fi
  ( umask 077; awk -v k="$key" -v v="$val" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$ENV_FILE.fb-tmp" )
  cat "$ENV_FILE.fb-tmp" > "$ENV_FILE"
  rm -f "$ENV_FILE.fb-tmp"
}

env_unset() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  ( umask 077; awk -v k="$key" 'index($0, k "=") != 1 { print }' "$ENV_FILE" > "$ENV_FILE.fb-tmp" )
  cat "$ENV_FILE.fb-tmp" > "$ENV_FILE"
  rm -f "$ENV_FILE.fb-tmp"
}

install_primary_from_file() {
  ( umask 077; mkdir -p "$SECRETS_DIR" )
  chmod 700 "$DEPLOY_ROOT/secrets" "$SECRETS_DIR"
  [ -d "$DROP_DIR" ] && chmod 700 "$DROP_DIR"
  local tmp="$SECRETS_DIR/.primary.json.tmp"
  rm -f "$tmp"
  # Validate in node; only the file paths go through env (never the key, never argv/stdout).
  ( umask 077; IN="$FIREBASE_SERVICE_ACCOUNT_FILE" OUT="$tmp" node -e '
      let raw = "";
      try { raw = require("fs").readFileSync(process.env.IN, "utf8"); } catch (e) { console.error("credential drop file unreadable"); process.exit(2); }
      let j;
      try { j = JSON.parse(raw); } catch (e) { console.error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON"); process.exit(2); }
      for (const k of ["project_id", "client_email", "private_key"]) {
        if (typeof j[k] !== "string" || !j[k]) { console.error("FIREBASE_SERVICE_ACCOUNT_JSON has no " + k); process.exit(2); }
      }
      if (!/BEGIN PRIVATE KEY/.test(j.private_key)) { console.error("FIREBASE_SERVICE_ACCOUNT_JSON private_key is malformed"); process.exit(2); }
      require("fs").writeFileSync(process.env.OUT, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
    ' )
  chmod 600 "$tmp"
  mv -f "$tmp" "$PRIMARY"
}

cmd_install() {
  if [ -n "${FIREBASE_SERVICE_ACCOUNT_FILE:-}" ]; then
    trap discard_drop EXIT
    if [ ! -f "$FIREBASE_SERVICE_ACCOUNT_FILE" ]; then
      echo "[firebase] ERROR: credential file $FIREBASE_SERVICE_ACCOUNT_FILE missing"
      return 1
    fi
    install_primary_from_file
    discard_drop
  elif [ ! -f "$PRIMARY" ]; then
    echo "[firebase] FIREBASE_SERVICE_ACCOUNT_JSON not provided and no primary credential installed — Firebase config unchanged"
    return 0
  fi
  chmod 600 "$PRIMARY"
  local primary_project
  primary_project="$(project_of "$PRIMARY")"
  if [ -z "$primary_project" ]; then
    echo "[firebase] ERROR: $PRIMARY is not a readable service account"
    return 1
  fi
  # Validate before changing anything: the primary needs its own RTDB URL.
  local current_url
  current_url="$(env_get FIREBASE_DATABASE_URL)"
  if [ -z "${FIREBASE_DATABASE_URL_VALUE:-}" ] \
    && ! printf '%s' "$current_url" | grep -q "$primary_project"; then
    echo "[firebase] ERROR: no RTDB URL for $primary_project (FIREBASE_DATABASE_URL is '${current_url}'); set the FIREBASE_DATABASE_URL variable for this environment"
    return 1
  fi

  # Legacy credential: the server's pre-move ./firebase.json, preserved once (copy, not move).
  if [ ! -f "$LEGACY" ] && [ -f "$LIVE_PATH/firebase.json" ]; then
    local old_project
    old_project="$(project_of "$LIVE_PATH/firebase.json")"
    if [ -n "$old_project" ] && [ "$old_project" != "$primary_project" ]; then
      ( umask 077; cp -p "$LIVE_PATH/firebase.json" "$SECRETS_DIR/.legacy.json.tmp" )
      chmod 600 "$SECRETS_DIR/.legacy.json.tmp"
      mv -f "$SECRETS_DIR/.legacy.json.tmp" "$LEGACY"
      echo "[firebase] preserved ./firebase.json ($old_project) as the legacy credential"
    fi
  fi
  local legacy_project=""
  if [ -f "$LEGACY" ]; then
    chmod 600 "$LEGACY"
    legacy_project="$(project_of "$LEGACY")"
    [ "$legacy_project" = "$primary_project" ] && legacy_project=""
  fi

  # RTDB URLs. The URL the server used so far belongs to the legacy project: keep it as the
  # legacy URL the first time (before FIREBASE_DATABASE_URL is pointed at the primary).
  if [ -n "$legacy_project" ]; then
    if [ -n "${FIREBASE_LEGACY_DATABASE_URL_VALUE:-}" ]; then
      env_set FIREBASE_LEGACY_DATABASE_URL "$FIREBASE_LEGACY_DATABASE_URL_VALUE"
    elif [ -z "$(env_get FIREBASE_LEGACY_DATABASE_URL)" ] && [ -n "$current_url" ] \
      && printf '%s' "$current_url" | grep -q "$legacy_project"; then
      env_set FIREBASE_LEGACY_DATABASE_URL "$current_url"
    fi
    env_set FIREBASE_LEGACY_CREDENTIALS_PATH "$LEGACY"
  else
    env_unset FIREBASE_LEGACY_CREDENTIALS_PATH
  fi

  if [ -n "${FIREBASE_DATABASE_URL_VALUE:-}" ]; then
    env_set FIREBASE_DATABASE_URL "$FIREBASE_DATABASE_URL_VALUE"
  fi
  env_set FIREBASE_CREDENTIALS_PATH "$PRIMARY"
  chmod 600 "$ENV_FILE" 2>/dev/null || true

  echo "[firebase] primary=$primary_project legacy=${legacy_project:-none} rtdb=$(env_get FIREBASE_DATABASE_URL) legacyRtdb=$(env_get FIREBASE_LEGACY_DATABASE_URL)"
}

cmd_downgrade() {
  local release="${1:?release dir required}"
  if [ -f "$release/utils/firebaseProjects.js" ]; then
    return 0
  fi
  if [ -z "$(env_get FIREBASE_CREDENTIALS_PATH)" ]; then
    return 0
  fi
  # The restored release reads ./firebase.json (+ FIREBASE_DATABASE_URL): the legacy project.
  if [ ! -f "$LIVE_PATH/firebase.json" ] && [ -f "$LEGACY" ]; then
    ( umask 077; cp -p "$LEGACY" "$LIVE_PATH/firebase.json" )
    chmod 600 "$LIVE_PATH/firebase.json"
  fi
  local legacy_url
  legacy_url="$(env_get FIREBASE_LEGACY_DATABASE_URL)"
  if [ -n "$legacy_url" ]; then
    env_set FIREBASE_DATABASE_URL "$legacy_url"
  else
    env_unset FIREBASE_DATABASE_URL
  fi
  echo "[firebase] restored release predates multi-project Firebase: FIREBASE_DATABASE_URL -> legacy RTDB (${legacy_url:-default})"
}

case "${1:-}" in
  install) cmd_install ;;
  discard) discard_drop ;;
  downgrade) shift; cmd_downgrade "$@" ;;
  *) echo "usage: $0 install | discard | downgrade <release-dir>"; exit 2 ;;
esac

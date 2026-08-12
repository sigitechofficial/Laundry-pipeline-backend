# Laundry Careflow-style SSH deployment

Replaces FTP (`SamKirkland/FTP-Deploy-Action` + `trigger.php`).

## Flow

```text
push main|stage
→ GitHub builds/packages release tar
→ SCP to /home/sigisolutions/deployments/laundry-api(-stage)/incoming
→ remote script: file backup + MySQL dump + rsync + npm ci + migrate + seeds + PM2 reload + smoke check
→ on failure: auto file rollback (DB not auto-restored)
```

## Workflows (backend repo)

| Workflow | Purpose |
|----------|---------|
| Deploy Laundry API | SSH release deploy |
| Rollback Laundry API | previous/specific release or file backup |
| Restore Laundry API Database | restore `db-before-*.sql.gz` |
| Pre-migration full backup | one-shot full snapshot |

## Workflows (admin repo)

| Workflow | Purpose |
|----------|---------|
| Deploy Laundry Admin | Vite `dist/` → Apache docroot |
| Rollback Laundry Admin | release/backup rollback |

## Required GitHub secrets

Shared (both repos / environments `production` + `staging`):

- `SSH_HOST` (e.g. `31.97.131.81`)
- `SSH_PORT` (`22`)
- `SSH_USER` (`sigisolutions`)
- `SSH_PRIVATE_KEY` (ed25519 private key)

Admin optional:

- `LAUNDRY_API_BASE_URL_PROD` / `LAUNDRY_API_BASE_URL_STAGE`
- `ADMIN_DEPLOY_PATH_PROD` / `ADMIN_DEPLOY_PATH_STAGE`
- `ADMIN_APP_URL_PROD` / `ADMIN_APP_URL_STAGE`
- `VITE_FIREBASE_*` public keys

## Server paths

| Env | Live app | Deploy root | PM2 |
|-----|----------|-------------|-----|
| prod API | `/home/sigisolutions/prodlaundry.sigisolutions.net` | `.../deployments/laundry-api` | `laundary` |
| stage API | `/home/sigisolutions/stagelaundry.sigisolutions.net` | `.../deployments/laundry-api-stage` | `laundary-stage` |
| admin | `/home/sigisolutions/adminlaundry.sigisolutions.net` (override via secret) | `.../deployments/laundry-admin` | static Apache |

Preserved on API deploy (never overwritten by rsync):

- `.env`
- `config/config.json`
- `firebase.json`
- `uploads/`
- `Public/`
- `.htaccess`

## Verify live version

After any deploy, open these (no auth):

| URL | Purpose |
|-----|---------|
| `GET /health` | Process alive |
| `GET /health/deploy` | Full deploy fingerprint (commit, times, run, backups, node) |
| `GET /health/schema` | Shop-review tables + SequelizeMeta + safe counts |
| `GET /version` | Same as `/health/deploy` |
| `GET /deploy/info` | Same as `/health/deploy` |
| `GET /release.json` | Same payload (raw-friendly) |

Authenticated ops (PM2 logs / reload) — see [OPS_CONTROL.md](./OPS_CONTROL.md):

| URL | Purpose |
|-----|---------|
| `GET /ops/status` | PM2 status (header `X-Ops-Token`) |
| `GET /ops/pm2/logs` | Tail PM2 logs |
| `POST /ops/pm2/reload` | `pm2 reload --update-env` |
| `POST /ops/pm2/restart` | `pm2 restart --update-env` |

```bash
curl -sS https://prodlaundry.sigisolutions.net/health/deploy | jq .
curl -sS https://stagelaundry.sigisolutions.net/health/deploy | jq .data.shortCommit
```

Remote smoke checks require `/health` = 200 and `/health/deploy` to contain the deployed commit.

## Roll-forward

Push a new commit to `stage`/`main`, or re-run **Deploy Laundry API** / **Deploy Laundry Admin**.

## First cutover checklist

1. Pre-migration backup already taken (`20260811-140721Z`).
2. Ensure GitHub Environments `production` and `staging` exist (optional protection rules).
3. Confirm `SSH_PRIVATE_KEY` works (already verified).
4. Dry-run: Actions → **Deploy Laundry API** → branch `stage` → workflow_dispatch.
5. Verify stage URL + PM2 `laundary-stage`.
6. Then deploy `main` / production.
7. Leave legacy FTP workflow disabled (stub only).

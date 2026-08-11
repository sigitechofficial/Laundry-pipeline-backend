# Pre-migration backups (stage + prod)

Take these **before** switching Laundry to Careflow-style SSH deploy.

## What gets saved

Under:

```text
/home/sigisolutions/deployments/laundry-pre-migration-backups/<UTC-timestamp>/
```

| Path | Contents |
|------|----------|
| `code/prod-backend.tar.gz` | Prod app tree (no `node_modules` / uploads) |
| `code/stage-backend.tar.gz` | Stage app tree |
| `code/admin-*.tar.gz` | Admin docroots if present under `sigisolutions` |
| `db/prod.sql.gz` | MySQL dump from prod `config/config.json` |
| `db/stage.sql.gz` | MySQL dump from stage `config/config.json` |
| `MANIFEST.txt` | Paths, sizes, sha256, PM2 list |
| `logs/backup.log` | Full run log |

Symlink / pointer:

```text
/home/sigisolutions/deployments/laundry-pre-migration-backups/latest
/home/sigisolutions/deployments/laundry-pre-migration-backups/LATEST.txt
```

## How to run (GitHub)

1. Push this workflow to the repo (already added as `.github/workflows/pre-migration-backup.yml`).
2. GitHub → **Actions** → **Pre-migration full backup (stage+prod)** → **Run workflow**.
3. Confirmation: type exactly `BACKUP`.
4. Open the job log and confirm `BACKUP COMPLETE` + non-empty dump sizes.

Requires existing secrets used by Live→Stage sync: `SSH_HOST`, `SSH_USER`, `SSH_PORT`, `SSH_PASSWORD`, `STAGE_FTP_USERNAME`, `STAGE_FTP_PASSWORD`.

## How to run (SSH on VPS)

```bash
export HOME=/home/sigisolutions
bash /home/sigisolutions/stagelaundry.sigisolutions.net/scripts/pre-migration-full-backup.sh
# or after first Actions run:
bash /home/sigisolutions/deployments/laundry-pre-migration-backups/pre-migration-full-backup.sh
```

## Restore code (example: prod)

```bash
PROD=/home/sigisolutions/prodlaundry.sigisolutions.net
BK=/home/sigisolutions/deployments/laundry-pre-migration-backups/latest

# optional safety copy of whatever is live now
tar -czf /tmp/prod-before-restore-$(date -u +%Y%m%d%H%M%SZ).tar.gz \
  --exclude=node_modules --exclude=uploads -C "$PROD" .

rsync -a --delete \
  --exclude=node_modules --exclude=uploads --exclude=.env \
  <(mkdir -p /tmp/restore-prod && tar -xzf "$BK/code/prod-backend.tar.gz" -C /tmp/restore-prod && echo /tmp/restore-prod)/ \
  "$PROD/"

# simpler:
rm -rf /tmp/restore-prod && mkdir -p /tmp/restore-prod
tar -xzf "$BK/code/prod-backend.tar.gz" -C /tmp/restore-prod
rsync -a --delete \
  --exclude=node_modules --exclude=uploads --exclude=.env --exclude=config/config.json \
  /tmp/restore-prod/ "$PROD/"

source ~/.nvm/nvm.sh
cd "$PROD" && npm ci --omit=dev
pm2 restart laundary --update-env || pm2 start laundary.js --name laundary
pm2 save
```

Prefer preserving live `.env` and `config/config.json` unless you intentionally restore them from the tarball (they are included in the tar).

## Restore database (example: stage)

```bash
# Read host/user/db from stage config, then:
gunzip -c /home/sigisolutions/deployments/laundry-pre-migration-backups/latest/db/stage.sql.gz \
  | mysql -h HOST -P PORT -u USER -p DATABASE
```

**Prod DB restore is destructive.** Confirm the dump sha256 from `MANIFEST.txt` before importing.

## Rule

Do **not** start Careflow-style deploy cutover until Actions shows `BACKUP COMPLETE` and `db_prod` / `db_stage` lines in the manifest have non-zero sizes.

# FTP deploy (GitHub Actions → cPanel)

Stage/prod use `SamKirkland/FTP-Deploy-Action` in `.github/workflows/laundary.yml`.

## Failures we hit

| Error | Cause | Fix in repo |
|--------|--------|-------------|
| `550 lib: No such file or directory` | cPanel FTP user could not `MKD lib/` | Migration helpers moved to `utils/migrationHelpers.js` (no top-level `lib/` folder) |
| `Timeout (control socket)` | Default FTP client timeout is **30s**; large sync or slow host | Workflow sets `timeout: 300000` and job `timeout-minutes: 45`; optional retry step |

## If deploy still times out

1. Re-run the workflow (transient FTP/network).
2. In hosting panel: confirm **FTP** (not SFTP-only) on port **21**, passive mode allowed.
3. If the host requires **FTPS**, set in workflow: `protocol: ftps`, `security: loose` (same port or host docs).
4. Manual fallback on server:
   ```bash
   cd /home/sigisolutions/stagelaundry.sigisolutions.net
   git pull origin stage
   npm install --production
   curl -sS -H "X-Ops-Token: $OPS_CONTROL_TOKEN" https://stagelaundry.sigisolutions.net/stage-trigger.php
   ```

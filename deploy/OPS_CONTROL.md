# Ops control plane (`/ops`)

Authenticated endpoints + local scripts so operators (and Cursor) can read PM2 / deploy logs, run a one-shot diagnose, and reload the API **without cPanel/SSH**.

## Auth

Set one shared secret in GitHub Actions:

- Repo (or environment) secret: `OPS_CONTROL_TOKEN`

Each deploy writes it to:

- `$LIVE_PATH/.ops-control-token` (chmod 600)
- upserts `OPS_CONTROL_TOKEN=...` in `$LIVE_PATH/.env`

Call with header:

```http
X-Ops-Token: <OPS_CONTROL_TOKEN>
```

If the token is missing on the server, `/ops/*` returns **503**.

## Endpoints (stage + prod — same paths)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/ops/status` | PM2 process status (no env secrets) + deploy fingerprint |
| GET | `/ops/diagnose?logLines=120` | **One-shot:** PM2 + mysql/redis/… + schema + recent error lines + migrate/seed tails |
| GET | `/ops/pm2/logs?lines=200&stream=both\|out\|err&grep=Error` | Tail / filter PM2 logs (redacted) |
| GET | `/ops/deploy-logs?name=migrate\|seed\|deploy&lines=200` | Tail last migrate/seed/deploy log file |
| POST | `/ops/pm2/reload` | `pm2 reload <app> --update-env` — body `{ "confirm": true }` |
| POST | `/ops/pm2/restart` | `pm2 restart <app> --update-env` — body `{ "confirm": true }` |

## Local script (no cPanel)

From `Laundry-pipeline-backend` (token file: `.ops-control-token`):

```bash
chmod +x scripts/ops.sh

# Full diagnose (preferred when something is broken)
npm run ops:diagnose
# or
./scripts/ops.sh stage diagnose

# PM2 logs
./scripts/ops.sh stage logs err 150
./scripts/ops.sh stage logs both 200 Error
./scripts/ops.sh stage errors

# Deploy DB logs
./scripts/ops.sh stage migrate
./scripts/ops.sh stage seed

# Reload after .env change
./scripts/ops.sh stage reload

# Prod (after /ops is deployed on main)
./scripts/ops.sh prod diagnose
./scripts/ops.sh prod logs err 200
```

Also:

```bash
npm run ops:stage -- diagnose
npm run ops:stage -- logs err 100
npm run ops:prod -- diagnose
```

## curl examples

```bash
export OPS_TOKEN='…'   # same as GitHub secret OPS_CONTROL_TOKEN

curl -sS -H "X-Ops-Token: $OPS_TOKEN" \
  'https://stagelaundry.sigisolutions.net/ops/diagnose' | jq .

curl -sS -H "X-Ops-Token: $OPS_TOKEN" \
  'https://stagelaundry.sigisolutions.net/ops/pm2/logs?lines=100&stream=err' | jq -r .data.text

curl -sS -X POST -H "X-Ops-Token: $OPS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"confirm":true}' \
  'https://stagelaundry.sigisolutions.net/ops/pm2/reload'
```

## Safety

- Timing-safe token compare; unauthorized attempts logged as `[OPS] unauthorized`
- PM2 describe never returns env values
- Log text lightly redacts bearer tokens / Stripe keys / known secret env names
- Mutate endpoints require `{ "confirm": true }` and a 15s cooldown
- Prod deploy: put the same secret on `main` / production environment, then run **Deploy Laundry API** for `main`

## Local agent copy

Keep a local (gitignored) copy at `Laundry-pipeline-backend/.ops-control-token` matching the GitHub secret so Cursor can call `/ops` without pasting the token every time.

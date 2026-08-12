# Ops control plane (`/ops`)

Authenticated endpoints so operators (and Cursor) can read PM2 / deploy logs and reload the API **without SSH**.

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
| GET | `/ops/pm2/logs?lines=200&stream=both\|out\|err` | Tail PM2 logs (redacted) |
| GET | `/ops/deploy-logs?name=migrate\|seed\|deploy&lines=200` | Tail last migrate/seed/deploy log file |
| POST | `/ops/pm2/reload` | `pm2 reload <app> --update-env` — body `{ "confirm": true }` |
| POST | `/ops/pm2/restart` | `pm2 restart <app> --update-env` — body `{ "confirm": true }` |

Examples:

```bash
export OPS_TOKEN='…'   # same as GitHub secret OPS_CONTROL_TOKEN

# Stage
curl -sS -H "X-Ops-Token: $OPS_TOKEN" \
  'https://stagelaundry.sigisolutions.net/ops/status' | jq .

curl -sS -H "X-Ops-Token: $OPS_TOKEN" \
  'https://stagelaundry.sigisolutions.net/ops/pm2/logs?lines=100&stream=err' | jq -r .data.text

curl -sS -X POST -H "X-Ops-Token: $OPS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"confirm":true}' \
  'https://stagelaundry.sigisolutions.net/ops/pm2/reload'

# Prod
curl -sS -H "X-Ops-Token: $OPS_TOKEN" \
  'https://prodlaundry.sigisolutions.net/ops/status' | jq .
```

## Safety

- Timing-safe token compare; unauthorized attempts logged as `[OPS] unauthorized`
- PM2 describe never returns env values
- Log text lightly redacts bearer tokens / Stripe keys / known secret env names
- Mutate endpoints require `{ "confirm": true }` and a 15s cooldown
- Prod deploy: put the same secret on `main` / production environment, then run **Deploy Laundry API** for `main`

## Local agent copy

Keep a local (gitignored) copy at `Laundry-pipeline-backend/.ops-control-token` matching the GitHub secret so Cursor can call `/ops` without pasting the token every time.

# Local / new-server database setup

**Primary path for every new machine or empty database:** create the DB, then run migrations. No ensure-scripts, no SequelizeMeta patches.

Verified: a wipe of `laundry_pipeline_fresh` + full `db:migrate` applies all numbered migrations cleanly.

## Prerequisites

- MySQL 8 (MAMP, Docker, or system MySQL)
- Node `>=18` (`engines` in `package.json`)
- `npm install` in this repo

Edit `config/config.json` → `development` (host, port, user, password, database).  
Default local example (MAMP):

```json
{
  "development": {
    "username": "root",
    "password": "root",
    "database": "laundry_pipeline",
    "host": "127.0.0.1",
    "port": 8889,
    "dialect": "mysql"
  }
}
```

Match `.env` / app `DB_*` settings to the same database.

## One command (recommended)

```bash
npm run db:setup
```

This:

1. Creates the database if it does not exist  
2. Runs `npx sequelize-cli db:migrate`  
3. Prints `SequelizeMeta` count vs migration file count (should match)

### Wipe and rebuild (local only)

```bash
npm run db:setup:reset
```

### Manual equivalent

```bash
mysql -e "CREATE DATABASE IF NOT EXISTS laundry_pipeline CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
npx sequelize-cli db:migrate
```

Optional seeders (roles, units, etc.) after migrate:

```bash
npx sequelize-cli db:seed:all
```

## New empty server (stage/prod-shaped)

Same rule: empty schema → **only** `db:migrate`.

```bash
npm ci   # or npm install
npx sequelize-cli db:migrate
```

Do **not** run `repair-sequelize-meta` or `ensure-*.js` on a brand-new database.

## Existing drifted DB (stage/live only)

If schema was built historically via `sync` / SQL and `SequelizeMeta` is incomplete, see [SEQUELIZE_META_AND_MIGRATIONS.md](./SEQUELIZE_META_AND_MIGRATIONS.md). That path is for **repairing old environments**, not for onboarding.

## CI / sanity check

Throwaway DB used in tooling (`config/config.fresh.json`):

```bash
npm run db:migrate:verify
```

Resets `laundry_pipeline_fresh` and migrates until success. Use before merging migration changes.

## Rules

1. Schema changes = new file under `migrations/` only.  
2. Shared helpers live in `lib/migrationHelpers.js` (not inside `migrations/`).  
3. Migrations must be greenfield-safe (idempotent column adds where needed).  
4. Do not use `sequelize.sync({ alter: true })` as the source of truth on shared environments.

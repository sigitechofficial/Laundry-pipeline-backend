# SequelizeMeta & migrations (root cause + durable process)

> **New laptop / empty server?** Use [LOCAL_DATABASE_SETUP.md](./LOCAL_DATABASE_SETUP.md) — `npm run db:setup` only.  
> This doc is for **existing** stage/live DBs whose `SequelizeMeta` drifted. Do not run repair/baseline on a fresh database.

## What went wrong (root cause)

This was **not** a one bad `db:migrate` command. The system process was wrong:

1. **Schema history was incomplete in `SequelizeMeta`**  
   Stage/prod schema grew via a mix of `sequelize.sync`, SQL, ensure-scripts, and partial migrates. Disk has ~100+ migration files; meta often had ~60 rows.

2. **Live → Stage DB sync overwrote meta with live’s history**  
   `scripts/live-to-stage-db-sync.js` restores a full live dump onto stage, including live’s `SequelizeMeta`. If live meta is incomplete (or behind stage-only migrations), stage meta becomes wrong again after every sync.

3. **Then `db:migrate` looked “broken”**  
   Sequelize treats “file on disk but not in meta” as pending → it tries to re-run old `create-*` migrations → conflicts / validation errors.

One-off `ensure-*.js` scripts and “don’t migrate” advice were **containment**, not the cure.

## Durable fix (what we do now)

| Step | Action |
|------|--------|
| **One-time baseline** (current stage already matches code) | `node scripts/repair-sequelize-meta.js --apply --baseline --i-know-schema-matches-repo` |
| **Every Live→Stage sync** | After restore: safe meta repair (`--apply`) then `npx sequelize-cli db:migrate` so stage catches migrations live doesn’t have |
| **Every stage deploy** (`stage-trigger`) | `repair --apply` then `db:migrate` then PM2 restart |

After baseline, **new schema changes = new migration file only**. No more ensure-scripts as the primary path.

## Commands (stage server)

```bash
cd /home/sigisolutions/stagelaundry.sigisolutions.net

# ONE TIME — only if schema already matches this repo
node scripts/repair-sequelize-meta.js --apply --baseline --i-know-schema-matches-repo

# Verify
mysql ... -e "SELECT COUNT(*) FROM SequelizeMeta;"
# should be ≈ number of files in migrations/

# From then on, normal:
npx sequelize-cli db:migrate
```

## Rules (enterprise)

1. Schema changes only via `migrations/*.js`.
2. Never rely on `syncDb` / `sequelize.sync({ alter: true })` on shared stage/prod.
3. After Live→Stage sync, always repair meta + migrate (wired in sync script).
4. Do not run blind migrate on a known-drifted meta without repair/baseline first.
5. Prefer fixing meta over adding another `ensure-*.js` patch.

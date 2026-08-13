/**
 * Apply every migration file against the LIVE app database.
 *
 * Why: sequelize-cli db:migrate on prod often targeted the wrong config.json
 * env (stage), so SequelizeMeta/schema drifted. createBooking / OFD then 500'd
 * on Unknown column.
 *
 * Behavior:
 * - Connects using live config.json + .env (same pick as deploy migrate).
 * - Runs any migration NOT in SequelizeMeta.
 * - Re-runs idempotent migrations (addColumnIfMissing / tableExists /
 *   describeTable) even if already in meta, to heal missing columns.
 * - Duplicate-table/column errors are treated as already-applied.
 *
 *   node scripts/ensure-live-migrations.js
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Sequelize } = require('sequelize');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');

function loadDotEnv(root) {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function pickEnv() {
  try {
    const picked = require('child_process')
      .execFileSync('node', [path.join(__dirname, 'pick-sequelize-migrate-env.js')], {
        cwd: ROOT,
        env: process.env,
        encoding: 'utf8',
      })
      .trim();
    if (picked) return picked;
  } catch (_) {
    /* fall through */
  }
  return process.env.SEQUELIZE_ENV || process.env.NODE_ENV || 'development';
}

function loadSequelize() {
  const envName = pickEnv();
  process.env.SEQUELIZE_ENV = envName;
  const dotenv = loadDotEnv(ROOT);
  const cfgPath = path.join(ROOT, 'config', 'config.json');
  let block = {};
  if (fs.existsSync(cfgPath)) {
    const all = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    block = all[envName] || all.production || all.development || {};
  }

  const database =
    process.env.DB_NAME ||
    dotenv.DB_NAME ||
    dotenv.DATABASE ||
    block.database;
  const username =
    process.env.DB_USER || dotenv.DB_USER || dotenv.DB_USERNAME || block.username;
  const password =
    process.env.DB_PASSWORD || dotenv.DB_PASSWORD || block.password || '';
  const host =
    process.env.DB_HOST || dotenv.DB_HOST || block.host || '127.0.0.1';
  const port = Number(
    process.env.DB_PORT || dotenv.DB_PORT || block.port || 3306
  );

  if (!database || !username) {
    throw new Error('DB config missing for ensure-live-migrations');
  }

  const sequelize = new Sequelize(database, username, password, {
    host,
    port,
    dialect: 'mysql',
    logging: false,
  });
  sequelize.__envName = envName;
  return sequelize;
}

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js') && !f.startsWith('.'))
    .sort();
}

function isIdempotentSource(source) {
  return /addColumnIfMissing|tableExists|describeTable|columnExists/.test(
    source
  );
}

function isAlreadyAppliedError(err) {
  const msg = `${err.message || ''} ${err.parent?.message || ''} ${err.original?.message || ''}`;
  return /already exists|Duplicate column|ER_DUP_FIELDNAME|ER_TABLE_EXISTS_ERROR|ER_DUP_KEYNAME|Duplicate key name|Can't DROP|does not exist/i.test(
    msg
  );
}

async function metaHas(sequelize, name) {
  const [rows] = await sequelize.query(
    'SELECT name FROM SequelizeMeta WHERE name = :name LIMIT 1',
    { replacements: { name } }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function metaInsert(sequelize, name) {
  await sequelize.query(
    'INSERT INTO SequelizeMeta (name) VALUES (:name)',
    { replacements: { name } }
  );
}

async function main() {
  const sequelize = loadSequelize();
  const qi = sequelize.getQueryInterface();
  const files = listMigrationFiles();

  let applied = 0;
  let healed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const [dbRows] = await sequelize.query('SELECT DATABASE() AS currentDb');
    const currentDb = dbRows?.[0]?.currentDb || sequelize.config.database;
    console.log(
      `[ensure-live-migrations] env=${sequelize.__envName} db=${currentDb} files=${files.length}`
    );

    for (const name of files) {
      const file = path.join(MIGRATIONS_DIR, name);
      const source = fs.readFileSync(file, 'utf8');
      const idempotent = isIdempotentSource(source);
      const alreadyMeta = await metaHas(sequelize, name);

      if (alreadyMeta && !idempotent) {
        skipped += 1;
        continue;
      }

      try {
        const migration = require(file);
        if (typeof migration.up !== 'function') {
          console.log(`[ensure-live-migrations] SKIP no up(): ${name}`);
          skipped += 1;
          continue;
        }
        const label = alreadyMeta ? 'heal' : 'apply';
        console.log(`[ensure-live-migrations] ${label} ${name}`);
        await migration.up(qi, Sequelize);
        if (!alreadyMeta) {
          await metaInsert(sequelize, name);
          applied += 1;
          console.log(`[ensure-live-migrations] SequelizeMeta + ${name}`);
        } else {
          healed += 1;
        }
      } catch (err) {
        if (isAlreadyAppliedError(err)) {
          if (!(await metaHas(sequelize, name))) {
            await metaInsert(sequelize, name);
            console.log(
              `[ensure-live-migrations] already-present, meta + ${name}`
            );
          } else {
            console.log(
              `[ensure-live-migrations] already-present ${name}: ${err.message}`
            );
          }
          skipped += 1;
          continue;
        }
        failed += 1;
        console.error(
          `[ensure-live-migrations] FAIL ${name}: ${err.message || err}`
        );
      }
    }

    console.log(
      `[ensure-live-migrations] done applied=${applied} healed=${healed} skipped=${skipped} failed=${failed}`
    );
    if (failed > 0) {
      console.error(
        `[ensure-live-migrations] ${failed} migration(s) failed — see logs above`
      );
    }
  } finally {
    await sequelize.close();
  }
}

main().catch((err) => {
  console.error('[ensure-live-migrations] FAILED:', err.message || err);
  process.exitCode = 0;
});

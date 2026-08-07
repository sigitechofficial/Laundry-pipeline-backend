/**
 * Repair out-of-sync SequelizeMeta on an already-built DB (stage/prod).
 *
 * Why this exists:
 * - Disk has ~100+ migration files, but SequelizeMeta may only have ~60 rows.
 * - `db:migrate` then tries to re-run old create-* migrations → dangerous / fails.
 *
 * Safe strategy:
 * - For migrations missing from SequelizeMeta that CREATE a table:
 *     if that table already exists → mark migration as applied (INSERT IGNORE)
 * - Other missing migrations are listed for manual review (not auto-marked),
 *   unless --mark-non-create is passed (use only when you know DB is ahead).
 *
 * Usage (on server, from app root):
 *   node scripts/repair-sequelize-meta.js              # dry-run
 *   node scripts/repair-sequelize-meta.js --apply      # write safe marks
 *   node scripts/repair-sequelize-meta.js --apply --mark-non-create
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const MARK_NON_CREATE = process.argv.includes('--mark-non-create');

function loadDbConfig() {
  const cfgPath = path.join(__dirname, '../config/config.json');
  const env = process.env.NODE_ENV || 'development';
  const block = fs.existsSync(cfgPath)
    ? JSON.parse(fs.readFileSync(cfgPath, 'utf8'))[env] || {}
    : {};
  return {
    host: process.env.DB_HOST || block.host || '127.0.0.1',
    port: Number(process.env.DB_PORT || block.port || 3306),
    user: process.env.DB_USER || block.username,
    password: process.env.DB_PASSWORD || block.password,
    database: process.env.DB_NAME || block.database,
  };
}

function listMigrationFiles() {
  const dir = path.join(__dirname, '../migrations');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

function extractCreateTableNames(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const names = new Set();
  const re = /createTable\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return [...names];
}

async function tableExists(conn, schema, table) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`,
    [schema, table]
  );
  return rows.length > 0;
}

async function main() {
  const cfg = loadDbConfig();
  if (!cfg.database || !cfg.user) {
    throw new Error('DB config missing');
  }

  const files = listMigrationFiles();
  const conn = await mysql.createConnection(cfg);

  try {
    const [metaRows] = await conn.query('SELECT name FROM SequelizeMeta');
    const meta = new Set(metaRows.map((r) => r.name));

    const missing = files.filter((f) => !meta.has(f));
    console.log('=== SequelizeMeta repair ===');
    console.log('database:', cfg.database);
    console.log('migration files on disk:', files.length);
    console.log('SequelizeMeta rows:', meta.size);
    console.log('missing from meta:', missing.length);
    console.log('mode:', APPLY ? 'APPLY' : 'DRY-RUN');
    console.log('');

    const markSafe = [];
    const needsReview = [];
    const markNonCreate = [];

    for (const file of missing) {
      const full = path.join(__dirname, '../migrations', file);
      const tables = extractCreateTableNames(full);

      if (tables.length) {
        const existence = [];
        for (const t of tables) {
          existence.push({
            table: t,
            exists: await tableExists(conn, cfg.database, t),
          });
        }
        const allExist = existence.every((e) => e.exists);
        if (allExist) {
          markSafe.push({ file, tables: existence.map((e) => e.table) });
        } else {
          needsReview.push({
            file,
            reason: 'createTable target missing in DB',
            tables: existence,
          });
        }
      } else if (MARK_NON_CREATE) {
        markNonCreate.push({ file, reason: 'non-create migration (--mark-non-create)' });
      } else {
        needsReview.push({
          file,
          reason: 'alter/add migration — not auto-marked (pass --mark-non-create if DB already has these changes)',
          tables: [],
        });
      }
    }

    console.log(`SAFE TO MARK (create table already exists): ${markSafe.length}`);
    markSafe.slice(0, 40).forEach((x) => {
      console.log(`  + ${x.file}  tables=[${x.tables.join(', ')}]`);
    });
    if (markSafe.length > 40) console.log(`  ... +${markSafe.length - 40} more`);

    if (markNonCreate.length) {
      console.log(`\nWILL MARK (non-create, flagged): ${markNonCreate.length}`);
      markNonCreate.slice(0, 40).forEach((x) => console.log(`  + ${x.file}`));
    }

    console.log(`\nNEEDS REVIEW (left pending): ${needsReview.length}`);
    needsReview.slice(0, 50).forEach((x) => {
      console.log(`  ? ${x.file}`);
      console.log(`      ${x.reason}`);
      if (x.tables?.length) {
        x.tables.forEach((t) =>
          console.log(`      - ${t.table}: ${t.exists ? 'exists' : 'MISSING'}`)
        );
      }
    });
    if (needsReview.length > 50) console.log(`  ... +${needsReview.length - 50} more`);

    const toInsert = [
      ...markSafe.map((x) => x.file),
      ...markNonCreate.map((x) => x.file),
    ];

    if (!APPLY) {
      console.log('\nDry-run only. Re-run with --apply to write SequelizeMeta.');
      console.log('Recommended first apply:');
      console.log('  node scripts/repair-sequelize-meta.js --apply');
      return;
    }

    let inserted = 0;
    for (const name of toInsert) {
      const [result] = await conn.query(
        'INSERT IGNORE INTO SequelizeMeta (name) VALUES (?)',
        [name]
      );
      if (result.affectedRows > 0) inserted += 1;
    }

    const [after] = await conn.query('SELECT COUNT(*) AS c FROM SequelizeMeta');
    console.log(`\nInserted ${inserted} meta rows. SequelizeMeta now: ${after[0].c}`);
    console.log(
      needsReview.length
        ? `Still pending review: ${needsReview.length} (do NOT blind db:migrate until reviewed).`
        : 'No pending review items — db:migrate should only run truly new migrations.'
    );
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});

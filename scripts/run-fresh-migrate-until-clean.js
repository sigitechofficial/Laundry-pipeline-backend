/**
 * Drop/create a throwaway DB and run migrations until success or max rounds.
 * Prints each failure so we can fix greenfield migrate permanently.
 *
 *   node scripts/run-fresh-migrate-until-clean.js
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'config.fresh.json');
const DB_NAME = 'laundry_pipeline_fresh';
const MAX_ROUNDS = 40;

function runMigrate() {
  const r = spawnSync(
    'npx',
    ['sequelize-cli', 'db:migrate', '--config', 'config/config.fresh.json', '--env', 'development'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  return {
    status: r.status,
    out: `${r.stdout || ''}\n${r.stderr || ''}`,
  };
}

function extractError(out) {
  const lines = out.split('\n');
  const err = lines.find((l) => l.startsWith('ERROR:'));
  const migrating = [...lines].reverse().find((l) => l.includes(': migrating'));
  return { err: err || 'UNKNOWN', migrating: migrating || '' };
}

async function resetDb() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).development;
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.username,
    password: cfg.password,
    multipleStatements: true,
  });
  await conn.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
  await conn.query(
    `CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.end();
}

async function metaCount() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).development;
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.username,
    password: cfg.password,
    database: DB_NAME,
  });
  try {
    const [rows] = await conn.query('SELECT COUNT(*) AS c FROM SequelizeMeta');
    return rows[0].c;
  } catch {
    return 0;
  } finally {
    await conn.end();
  }
}

async function main() {
  console.log('Resetting', DB_NAME);
  await resetDb();

  const failures = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n===== MIGRATE ROUND ${round} =====`);
    const { status, out } = runMigrate();
    const count = await metaCount();
    if (status === 0) {
      console.log('SUCCESS: all migrations applied. SequelizeMeta rows:', count);
      console.log('\nFailure history this session:', failures.length ? failures : 'none');
      process.exit(0);
    }
    const { err, migrating } = extractError(out);
    console.log(migrating);
    console.log(err);
    console.log('SequelizeMeta rows so far:', count);
    failures.push({ round, migrating, err, meta: count });
    // stop if no progress (same meta count twice with same error)
    if (
      failures.length >= 2 &&
      failures[failures.length - 1].meta === failures[failures.length - 2].meta &&
      failures[failures.length - 1].err === failures[failures.length - 2].err
    ) {
      console.error('\nSTOPPED: no progress — fix the migration above, then re-run.');
      process.exit(1);
    }
  }
  console.error('STOPPED: max rounds');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

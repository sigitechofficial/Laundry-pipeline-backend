/**
 * Create the local MySQL database (if missing) and run all migrations.
 *
 * Uses config/config.json → development by default.
 *
 *   npm run db:setup
 *   node scripts/db-setup-local.js
 *   node scripts/db-setup-local.js --env development
 *   node scripts/db-setup-local.js --config config/config.fresh.json --reset
 *
 * --reset  drops and recreates the database (destructive; local/throwaway only)
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = {
    env: 'development',
    config: path.join(ROOT, 'config', 'config.json'),
    reset: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') out.env = argv[++i];
    else if (a === '--config') out.config = path.resolve(ROOT, argv[++i]);
    else if (a === '--reset') out.reset = true;
  }
  return out;
}

async function ensureDatabase(cfg, { reset }) {
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port || 3306,
    user: cfg.username,
    password: cfg.password,
    multipleStatements: true,
  });
  try {
    if (reset) {
      console.log(`Dropping database \`${cfg.database}\` (reset)...`);
      await conn.query(`DROP DATABASE IF EXISTS \`${cfg.database}\``);
    }
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log(`Database ready: ${cfg.database} @ ${cfg.host}:${cfg.port || 3306}`);
  } finally {
    await conn.end();
  }
}

function runMigrate(configPath, envName) {
  console.log('Running migrations...');
  const r = spawnSync(
    'npx',
    ['sequelize-cli', 'db:migrate', '--config', path.relative(ROOT, configPath), '--env', envName],
    { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' }
  );
  if (r.status !== 0) {
    throw new Error(`db:migrate failed with exit ${r.status}`);
  }
}

async function metaCount(cfg) {
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port || 3306,
    user: cfg.username,
    password: cfg.password,
    database: cfg.database,
  });
  try {
    const [rows] = await conn.query('SELECT COUNT(*) AS c FROM SequelizeMeta');
    return rows[0].c;
  } finally {
    await conn.end();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.config)) {
    throw new Error(`Config not found: ${args.config}`);
  }
  const all = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  const cfg = all[args.env];
  if (!cfg) {
    throw new Error(`Env "${args.env}" missing in ${args.config}`);
  }

  const migrationFiles = fs
    .readdirSync(path.join(ROOT, 'migrations'))
    .filter((f) => /^\d+.*\.js$/.test(f)).length;

  await ensureDatabase(cfg, { reset: args.reset });
  runMigrate(args.config, args.env);

  const applied = await metaCount(cfg);
  console.log(`\nDone. SequelizeMeta: ${applied} / migration files: ${migrationFiles}`);
  if (applied !== migrationFiles) {
    console.warn(
      'Warning: meta count ≠ migration file count. See docs/SEQUELIZE_META_AND_MIGRATIONS.md'
    );
    process.exitCode = 2;
  } else {
    console.log('Greenfield migrate looks clean.');
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

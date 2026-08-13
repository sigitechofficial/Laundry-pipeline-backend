/**
 * Idempotent invoice auto-charge / OFD payment-gate columns on bookings.
 * Prod previously skipped this migrate, so createBooking INSERTs fail with
 * Unknown column 'autoChargeStatus'.
 *
 *   node scripts/ensure-invoice-auto-charge-schema.js
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Sequelize } = require('sequelize');

const MIGRATIONS = [
  '20260805160000-add-default-payment-method-to-users.js',
  '20260806163000-add-invoice-auto-charge-and-payment-attempts.js',
];

function loadSequelize() {
  const cfgPath = path.join(__dirname, '../config/config.json');
  const envName = process.env.SEQUELIZE_ENV || process.env.NODE_ENV || 'development';
  let block = {};
  if (fs.existsSync(cfgPath)) {
    const all = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    block = all[envName] || all.production || all.development || {};
  }

  const database =
    process.env.DB_NAME || process.env.DATABASE || block.database;
  const username = process.env.DB_USER || block.username;
  const password = process.env.DB_PASSWORD || block.password || '';
  const host = process.env.DB_HOST || block.host || '127.0.0.1';
  const port = Number(process.env.DB_PORT || block.port || 3306);

  if (!database || !username) {
    throw new Error('DB config missing for ensure-invoice-auto-charge-schema');
  }

  return new Sequelize(database, username, password, {
    host,
    port,
    dialect: 'mysql',
    logging: false,
  });
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
  try {
    const picked = require('child_process')
      .execFileSync('node', [path.join(__dirname, 'pick-sequelize-migrate-env.js')], {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        encoding: 'utf8',
      })
      .trim();
    if (picked) process.env.SEQUELIZE_ENV = picked;
  } catch (_) {
    /* keep defaults */
  }

  const sequelize = loadSequelize();
  const qi = sequelize.getQueryInterface();

  console.log(
    `[ensure-auto-charge] sequelizeEnv=${process.env.SEQUELIZE_ENV || 'development'} db=${sequelize.config.database}`
  );

  try {
    for (const name of MIGRATIONS) {
      const file = path.join(__dirname, '../migrations', name);
      if (!fs.existsSync(file)) {
        console.log(`[ensure-auto-charge] SKIP missing migration file: ${name}`);
        continue;
      }

      const alreadyMeta = await metaHas(sequelize, name);
      const migration = require(file);
      console.log(`[ensure-auto-charge] applying ${name} (meta=${alreadyMeta})...`);
      await migration.up(qi, Sequelize);
      if (!alreadyMeta) {
        await metaInsert(sequelize, name);
        console.log(`[ensure-auto-charge] SequelizeMeta + ${name}`);
      } else {
        console.log(`[ensure-auto-charge] columns ensured (already in SequelizeMeta): ${name}`);
      }
    }
    console.log('[ensure-auto-charge] done');
  } finally {
    await sequelize.close();
  }
}

main().catch((err) => {
  console.error('[ensure-auto-charge] FAILED:', err.message || err);
  process.exitCode = 0;
});

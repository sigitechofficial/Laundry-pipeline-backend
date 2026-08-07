/**
 * Safe one-off: create admin_push_logs if missing + mark migration in SequelizeMeta.
 * Use this on stage/prod when full `db:migrate` is unsafe (empty/out-of-sync SequelizeMeta).
 *
 *   node scripts/ensure-admin-push-logs.js
 */
'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const MIGRATION_NAME = '20260807140000-create-admin-push-logs.js';

function loadDbConfig() {
  const cfgPath = path.join(__dirname, '../config/config.json');
  const env = process.env.NODE_ENV || 'development';
  if (fs.existsSync(cfgPath)) {
    const all = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const block = all[env] || all.development || {};
    return {
      host: process.env.DB_HOST || block.host || '127.0.0.1',
      port: Number(process.env.DB_PORT || block.port || 3306),
      user: process.env.DB_USER || block.username,
      password: process.env.DB_PASSWORD || block.password,
      database: process.env.DB_NAME || block.database,
    };
  }
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
}

async function main() {
  const cfg = loadDbConfig();
  if (!cfg.database || !cfg.user) {
    throw new Error('DB config missing (config.json / env)');
  }

  const conn = await mysql.createConnection(cfg);
  try {
    const [tables] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'admin_push_logs'`,
      [cfg.database]
    );

    if (!tables.length) {
      console.log('Creating admin_push_logs...');
      await conn.query(`
        CREATE TABLE admin_push_logs (
          id INT NOT NULL AUTO_INCREMENT,
          audience VARCHAR(32) NOT NULL,
          mode VARCHAR(32) NOT NULL,
          title VARCHAR(160) NOT NULL,
          body TEXT NOT NULL,
          targetedUsers INT NOT NULL DEFAULT 0,
          usersDelivered INT NOT NULL DEFAULT 0,
          usersNoToken INT NOT NULL DEFAULT 0,
          usersFailed INT NOT NULL DEFAULT 0,
          deviceSuccessCount INT NOT NULL DEFAULT 0,
          deviceFailureCount INT NOT NULL DEFAULT 0,
          sentByAdminId INT NULL,
          payloadJson TEXT NULL,
          createdAt DATETIME NOT NULL,
          updatedAt DATETIME NOT NULL,
          PRIMARY KEY (id),
          KEY admin_push_logs_created_at (createdAt),
          KEY admin_push_logs_audience (audience),
          KEY admin_push_logs_sent_by (sentByAdminId)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('admin_push_logs created.');
    } else {
      console.log('admin_push_logs already exists — skip create.');
    }

    const [metaTables] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'SequelizeMeta'`,
      [cfg.database]
    );

    if (metaTables.length) {
      const [rows] = await conn.query(
        'SELECT name FROM SequelizeMeta WHERE name = ? LIMIT 1',
        [MIGRATION_NAME]
      );
      if (!rows.length) {
        await conn.query('INSERT INTO SequelizeMeta (name) VALUES (?)', [
          MIGRATION_NAME,
        ]);
        console.log('SequelizeMeta marked:', MIGRATION_NAME);
      } else {
        console.log('SequelizeMeta already has', MIGRATION_NAME);
      }
    } else {
      console.warn('SequelizeMeta table missing — skipped meta insert.');
    }

    console.log('OK — admin push audit table ready.');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});

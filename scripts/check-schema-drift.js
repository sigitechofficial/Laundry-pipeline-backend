/**
 * Schema drift guard: every Sequelize model attribute (including association foreign
 * keys added by belongsTo/hasMany) must exist as a column in a database built only by
 * migrations. Fails (exit 1) when a model expects a table or column that no migration
 * creates — the failure mode that broke fresh setups ("Unknown column 'userTypeId'").
 *
 *   npm run db:migrate && npm run db:check-drift
 *
 * Uses config/config.json for the current NODE_ENV (default development), like the app.
 * Read-only: it never alters the database.
 */
'use strict';

const db = require('../models');

const { sequelize, Sequelize } = db;

function modelsOf(registry) {
  return Object.values(registry).filter(
    (m) => m && typeof m === 'function' && m.prototype instanceof Sequelize.Model
  );
}

function tableNameOf(model) {
  const t = model.getTableName();
  return typeof t === 'string' ? t : t.tableName;
}

async function main() {
  const rows = await sequelize.query(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema = DATABASE()`,
    { type: Sequelize.QueryTypes.SELECT }
  );
  const columns = new Map();
  for (const { t, c } of rows) {
    if (!columns.has(t)) columns.set(t, new Set());
    columns.get(t).add(c);
  }

  const missingTables = [];
  const missingColumns = [];
  for (const model of modelsOf(db)) {
    const table = tableNameOf(model);
    const existing = columns.get(table);
    if (!existing) {
      missingTables.push(`${table} (model ${model.name})`);
      continue;
    }
    for (const [name, attr] of Object.entries(model.rawAttributes)) {
      if (attr.type instanceof Sequelize.VIRTUAL) continue;
      const field = attr.field || name;
      if (!existing.has(field)) missingColumns.push(`${table}.${field} (model ${model.name})`);
    }
  }

  const [{ dbName }] = await sequelize.query('SELECT DATABASE() AS dbName', {
    type: Sequelize.QueryTypes.SELECT,
  });
  if (missingTables.length || missingColumns.length) {
    console.error(`[schema-drift] Models expect schema that migrations do not create (db: ${dbName}).`);
    if (missingTables.length) console.error(`  Missing tables:\n    ${missingTables.join('\n    ')}`);
    if (missingColumns.length) console.error(`  Missing columns:\n    ${missingColumns.join('\n    ')}`);
    console.error('  Fix: add a migration for each item (never rely on sequelize.sync).');
    process.exitCode = 1;
  } else {
    console.log(`[schema-drift] OK — ${modelsOf(db).length} models match the migrated schema (db: ${dbName}).`);
  }
}

main()
  .catch((err) => {
    console.error('[schema-drift] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());

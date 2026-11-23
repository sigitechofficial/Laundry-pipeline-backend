'use strict';

/**
 * Idempotent seeding helpers.
 *
 * Seeders are not tracked (no seeder storage), so `db:seed:all` may run more than once
 * on the same database. Every seeder must therefore:
 *  - insert only rows whose natural key is not present yet (soft-deleted rows count as
 *    present, so an admin's deletion is respected), and
 *  - on undo, delete only the rows it seeds — never the whole table.
 *
 * Reference data keeps explicit ids because application code depends on them
 * (e.g. userTypeId 1 = Admin, 4 = Agent).
 */

/**
 * Insert the rows whose `key` value does not exist in `table`.
 * createdAt/updatedAt are filled when the table has them and the row omits them.
 * @returns {Promise<number>} number of rows inserted
 */
async function insertMissing(queryInterface, table, rows, { key = 'id', timestamps = true } = {}) {
  if (!rows.length) return 0;
  const keys = rows.map((r) => r[key]);
  const [existing] = await queryInterface.sequelize.query(
    `SELECT \`${key}\` AS k FROM \`${table}\` WHERE \`${key}\` IN (:keys)`,
    { replacements: { keys } }
  );
  const present = new Set(existing.map((r) => String(r.k)));
  const now = new Date();
  const missing = rows
    .filter((r) => !present.has(String(r[key])))
    .map((r) => (timestamps ? { createdAt: now, updatedAt: now, ...r } : { ...r }));
  if (missing.length) await queryInterface.bulkInsert(table, missing);
  return missing.length;
}

/** Delete only the rows this seeder owns (matched on `key`). */
async function deleteSeeded(queryInterface, table, rows, { key = 'id' } = {}) {
  const keys = rows.map((r) => r[key]);
  if (!keys.length) return;
  await queryInterface.bulkDelete(table, { [key]: keys });
}

module.exports = { insertMissing, deleteSeeded };

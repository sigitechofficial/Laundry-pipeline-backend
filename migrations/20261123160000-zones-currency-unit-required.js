'use strict';

/**
 * Every zone has a currency: zones.currencyUnitId becomes NOT NULL.
 *
 * Money (bills, Stripe charges, wallets, reports) takes its currency from the zone's
 * currency unit; the code no longer falls back to a platform default, so a zone
 * without one would leave its bookings with no currency at all.
 *
 *   1. Refuses to run while any zone (soft-deleted ones included — the column constraint
 *      covers every row) has no currency, naming those zones. A currency is never
 *      invented here: set each zone's currency in the admin panel, then re-run.
 *   2. The foreign key to units was ON DELETE SET NULL (it would null a NOT NULL column),
 *      so it is replaced with ON DELETE RESTRICT: a currency unit in use by a zone
 *      cannot be deleted.
 *   3. Makes the column NOT NULL.
 *
 * Idempotent: each step checks the live schema first.
 */
const TABLE = 'zones';
const COLUMN = 'currencyUnitId';
const FK = 'fk_zones_currencyUnitId';

async function select(queryInterface, sql, replacements, transaction) {
  return queryInterface.sequelize.query(sql, {
    replacements,
    transaction,
    type: queryInterface.sequelize.QueryTypes.SELECT,
  });
}

/** Foreign keys on zones.currencyUnitId with their delete rule (any name: sync-built DBs differ). */
async function currencyForeignKeys(queryInterface, transaction) {
  return select(
    queryInterface,
    `SELECT k.CONSTRAINT_NAME AS name, r.DELETE_RULE AS deleteRule
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ? AND k.COLUMN_NAME = ?
        AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
    [TABLE, COLUMN],
    transaction
  );
}

async function isNullable(queryInterface, transaction) {
  const [row] = await select(
    queryInterface,
    `SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [TABLE, COLUMN],
    transaction
  );
  if (!row) throw new Error(`[zones-currency-unit-required] ${TABLE}.${COLUMN} does not exist`);
  return row.nullable === 'YES';
}

async function replaceForeignKey(queryInterface, onDelete) {
  for (const fk of await currencyForeignKeys(queryInterface)) {
    await queryInterface.removeConstraint(TABLE, fk.name);
  }
  await queryInterface.addConstraint(TABLE, {
    fields: [COLUMN],
    type: 'foreign key',
    name: FK,
    references: { table: 'units', field: 'id' },
    onDelete,
    onUpdate: 'CASCADE',
  });
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const missing = await select(
      queryInterface,
      `SELECT id, name, deletedAt FROM ${TABLE} WHERE ${COLUMN} IS NULL ORDER BY id`
    );
    if (missing.length) {
      const list = missing
        .map((z) => `#${z.id} "${z.name}"${z.deletedAt ? ' (soft-deleted)' : ''}`)
        .join(', ');
      throw new Error(
        `[zones-currency-unit-required] ${missing.length} zone(s) have no currency: ${list}. ` +
          'Set each zone\'s currency (zones.currencyUnitId → a currency row in units) and re-run. ' +
          'This migration never picks a currency for a zone.'
      );
    }

    const fks = await currencyForeignKeys(queryInterface);
    const fkOk = fks.length === 1 && fks[0].name === FK && fks[0].deleteRule === 'RESTRICT';
    if (!fkOk) await replaceForeignKey(queryInterface, 'RESTRICT');

    if (await isNullable(queryInterface)) {
      await queryInterface.changeColumn(TABLE, COLUMN, {
        type: Sequelize.INTEGER,
        allowNull: false,
      });
    }
  },

  async down(queryInterface, Sequelize) {
    if (!(await isNullable(queryInterface))) {
      await queryInterface.changeColumn(TABLE, COLUMN, {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }
    const fks = await currencyForeignKeys(queryInterface);
    const fkRestored = fks.length === 1 && fks[0].name === FK && fks[0].deleteRule === 'SET NULL';
    if (!fkRestored) await replaceForeignKey(queryInterface, 'SET NULL');
  },
};

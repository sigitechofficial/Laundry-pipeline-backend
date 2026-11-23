'use strict';

/**
 * Currency columns no longer have a database default.
 *
 * Every ledger row stores the currency of the money it records — the booking zone's,
 * the promotion's, the withdrawal's — and every insert path supplies it. A column default
 * ('GBP', 'USD', even '$' on wallets in some databases) only ever filled in a currency
 * the code had not decided, so a USD booking could silently get a GBP refund row or a
 * GBP zone a USD no-show fee.
 *
 *  - Ledger columns stay NOT NULL: a missing currency now fails the insert.
 *  - Policy config currencies stay nullable: NULL means "the booking zone's currency",
 *    which the fee services already apply (an admin-created policy used to get 'USD').
 *
 * Only the default is dropped (ALTER COLUMN … DROP DEFAULT keeps type, nullability and
 * comment). Existing rows are not touched. Idempotent.
 */
const COLUMNS = [
  // [table, column, previous default (for down)]
  ['booking_attempts', 'feeCurrency', 'USD'],
  ['booking_refunds', 'currency', 'GBP'],
  ['cancellation_policy_configs', 'prePickupAbsoluteCurrency', 'USD'],
  ['cancellation_policy_configs', 'unprocessedAbsoluteCurrency', 'USD'],
  ['customer_credit_entries', 'currency', 'GBP'],
  ['invoice_payment_attempts', 'currency', 'GBP'],
  ['no_show_policy_configs', 'currency', 'USD'],
  ['order_adjustments', 'currency', 'GBP'],
  ['promotion_redemptions', 'currency', 'GBP'],
  ['promotions', 'currency', 'GBP'],
  ['reschedule_policy_configs', 'atPickupAbsoluteCurrency', 'USD'],
  ['reschedule_policy_configs', 'atDeliveryAbsoluteCurrency', 'USD'],
  ['wallets', 'currency', 'GBP'],
];

async function currentDefault(queryInterface, table, column) {
  const [row] = await queryInterface.sequelize.query(
    `SELECT COLUMN_DEFAULT AS dflt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    { replacements: [table, column], type: queryInterface.sequelize.QueryTypes.SELECT }
  );
  return row ? { exists: true, dflt: row.dflt } : { exists: false, dflt: null };
}

module.exports = {
  async up(queryInterface) {
    for (const [table, column] of COLUMNS) {
      const { exists, dflt } = await currentDefault(queryInterface, table, column);
      if (!exists || dflt == null) continue;
      await queryInterface.sequelize.query(`ALTER TABLE \`${table}\` ALTER COLUMN \`${column}\` DROP DEFAULT`);
    }
  },

  async down(queryInterface) {
    for (const [table, column, previous] of COLUMNS) {
      const { exists, dflt } = await currentDefault(queryInterface, table, column);
      if (!exists || dflt != null) continue;
      await queryInterface.sequelize.query(
        `ALTER TABLE \`${table}\` ALTER COLUMN \`${column}\` SET DEFAULT ${queryInterface.sequelize.escape(previous)}`
      );
    }
  },
};

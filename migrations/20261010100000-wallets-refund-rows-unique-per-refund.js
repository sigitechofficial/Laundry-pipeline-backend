'use strict';

/**
 * wallets_user_booking_reference_unique allowed ONE row per (shop owner, booking,
 * referenceType). Refund rows (commission clawback, cash refunded, extra-tip
 * clawback) need one row per refund: a partial refund followed by a second or
 * full refund hit a duplicate-key error after Stripe had already refunded.
 *
 * New key: (userId, bookingId, referenceType, refundKey) where refundKey is the
 * row's description for refund rows (it carries the refund id and is already the
 * per-refund idempotency key in agentWalletService) and '' for everything else,
 * so commission / cash collected stay one per booking exactly as before.
 */
const REFUND_TYPES = "'commission_clawback','cash_refunded','extra_tip_clawback'";

async function indexExists(queryInterface, name) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'wallets' AND index_name = '${name}'`
  );
  return rows[0].cnt > 0;
}

async function columnExists(queryInterface, name) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'wallets' AND column_name = '${name}'`
  );
  return rows[0].cnt > 0;
}

module.exports = {
  async up(queryInterface) {
    if (!(await columnExists(queryInterface, 'refundKey'))) {
      await queryInterface.sequelize.query(
        `ALTER TABLE wallets ADD COLUMN refundKey VARCHAR(191)
           GENERATED ALWAYS AS (CASE WHEN referenceType IN (${REFUND_TYPES}) THEN LEFT(COALESCE(description, ''), 191) ELSE '' END) STORED`
      );
    }
    if (!(await indexExists(queryInterface, 'wallets_user_booking_reference_refund_unique'))) {
      await queryInterface.addIndex('wallets', {
        name: 'wallets_user_booking_reference_refund_unique',
        fields: ['userId', 'bookingId', 'referenceType', 'refundKey'],
        unique: true,
      });
    }
    if (await indexExists(queryInterface, 'wallets_user_booking_reference_unique')) {
      await queryInterface.removeIndex('wallets', 'wallets_user_booking_reference_unique');
    }
  },

  async down(queryInterface) {
    // Only safe while no booking has two refund rows of the same type.
    if (!(await indexExists(queryInterface, 'wallets_user_booking_reference_unique'))) {
      await queryInterface.addIndex('wallets', {
        name: 'wallets_user_booking_reference_unique',
        fields: ['userId', 'bookingId', 'referenceType'],
        unique: true,
      });
    }
    if (await indexExists(queryInterface, 'wallets_user_booking_reference_refund_unique')) {
      await queryInterface.removeIndex('wallets', 'wallets_user_booking_reference_refund_unique');
    }
    if (await columnExists(queryInterface, 'refundKey')) {
      await queryInterface.sequelize.query('ALTER TABLE wallets DROP COLUMN refundKey');
    }
  },
};

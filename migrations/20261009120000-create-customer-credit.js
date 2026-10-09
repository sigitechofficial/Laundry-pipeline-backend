'use strict';

/**
 * Customer credit ledger (cashback paid as in-app credit) — docs/CASHBACK_CREDIT_PLAN.md.
 * Also stores the expected cashback on a promotion hold.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = async (name) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${name}'`
      );
      return rows[0].cnt > 0;
    };
    const columnExists = async (table, column) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}'`
      );
      return rows[0].cnt > 0;
    };

    if (!(await tableExists('customer_credit_entries'))) {
      await queryInterface.createTable('customer_credit_entries', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        customerId: { type: Sequelize.INTEGER, allowNull: false },
        type: {
          type: Sequelize.ENUM('EARN', 'ADJUST', 'SPEND', 'REVERSE', 'RESTORE', 'EXPIRE'),
          allowNull: false,
        },
        status: {
          type: Sequelize.ENUM('POSTED', 'HELD', 'COMMITTED', 'RELEASED'),
          allowNull: false,
          defaultValue: 'POSTED',
          comment: 'SPEND: HELD → COMMITTED | RELEASED. Every other type is POSTED.',
        },
        amount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, comment: 'Signed: + adds credit, − takes it' },
        remainingAmount: {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: true,
          comment: 'Lots only (EARN, RESTORE, positive ADJUST): credit still available',
        },
        currency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'GBP' },
        expiresAt: { type: Sequelize.DATE, allowNull: true },
        bookingId: { type: Sequelize.INTEGER, allowNull: true },
        promotionId: { type: Sequelize.INTEGER, allowNull: true },
        redemptionId: { type: Sequelize.INTEGER, allowNull: true },
        sourceEntryId: { type: Sequelize.INTEGER, allowNull: true, comment: 'REVERSE/EXPIRE/RESTORE: the entry it relates to' },
        idempotencyKey: { type: Sequelize.STRING(120), allowNull: true, unique: true },
        description: { type: Sequelize.STRING(255), allowNull: true },
        reason: { type: Sequelize.STRING(500), allowNull: true },
        actorId: { type: Sequelize.INTEGER, allowNull: true },
        actorType: { type: Sequelize.STRING(20), allowNull: true, comment: 'system, admin' },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
      await queryInterface.addIndex('customer_credit_entries', ['customerId', 'type'], { name: 'idx_cce_customer_type' });
      await queryInterface.addIndex('customer_credit_entries', ['bookingId'], { name: 'idx_cce_booking' });
      await queryInterface.addIndex('customer_credit_entries', ['expiresAt'], { name: 'idx_cce_expires' });
    }

    if (!(await tableExists('customer_credit_allocations'))) {
      await queryInterface.createTable('customer_credit_allocations', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        spendEntryId: { type: Sequelize.INTEGER, allowNull: false },
        lotEntryId: { type: Sequelize.INTEGER, allowNull: false },
        amount: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
      await queryInterface.addIndex('customer_credit_allocations', ['spendEntryId'], { name: 'idx_cca_spend' });
      await queryInterface.addIndex('customer_credit_allocations', ['lotEntryId'], { name: 'idx_cca_lot' });
    }

    if (!(await columnExists('promotion_redemptions', 'cashbackAmount'))) {
      await queryInterface.addColumn('promotion_redemptions', 'cashbackAmount', {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        comment: 'Cashback priced on the invoice (credited after delivery)',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('promotion_redemptions', 'cashbackAmount').catch(() => {});
    await queryInterface.dropTable('customer_credit_allocations');
    await queryInterface.dropTable('customer_credit_entries');
  },
};

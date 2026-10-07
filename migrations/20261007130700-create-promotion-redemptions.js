'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = async (name) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${name}'`
      );
      return rows[0].cnt > 0;
    };

    if (await tableExists('promotion_redemptions')) return;

    // Ledger: every reserve / commit / release / reverse event
    await queryInterface.createTable('promotion_redemptions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },

      promotionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'promotions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      promotionVersionId: { type: Sequelize.INTEGER, allowNull: true },

      couponCodeId: { type: Sequelize.INTEGER, allowNull: true },
      couponCode: { type: Sequelize.STRING(50), allowNull: true },

      customerId: { type: Sequelize.INTEGER, allowNull: false },
      bookingId: { type: Sequelize.INTEGER, allowNull: true },

      // State machine: RESERVED → COMMITTED → (RELEASED | REVERSED)
      status: {
        type: Sequelize.ENUM('RESERVED', 'COMMITTED', 'RELEASED', 'REVERSED'),
        allowNull: false,
        defaultValue: 'RESERVED',
      },

      // Financial
      discountAmount: { type: Sequelize.DECIMAL(10, 2), allowNull: true, comment: 'Actual discount given' },
      currency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'GBP' },

      // Zone context
      zoneId: { type: Sequelize.INTEGER, allowNull: true },

      // Idempotency
      idempotencyKey: { type: Sequelize.STRING(200), allowNull: true },

      // Reservation expiry (auto-release stale reservations)
      reservedAt: { type: Sequelize.DATE, allowNull: true },
      reservationExpiresAt: { type: Sequelize.DATE, allowNull: true },

      committedAt: { type: Sequelize.DATE, allowNull: true },
      releasedAt: { type: Sequelize.DATE, allowNull: true },
      reversedAt: { type: Sequelize.DATE, allowNull: true },

      reason: { type: Sequelize.STRING(500), allowNull: true },

      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('promotion_redemptions', ['promotionId', 'customerId'], { name: 'idx_pr_promo_customer' });
    await queryInterface.addIndex('promotion_redemptions', ['bookingId'], { name: 'idx_pr_booking' });
    await queryInterface.addIndex('promotion_redemptions', ['status'], { name: 'idx_pr_status' });
    await queryInterface.addIndex('promotion_redemptions', ['couponCode'], { name: 'idx_pr_coupon' });
    await queryInterface.addIndex('promotion_redemptions', ['idempotencyKey'], { name: 'idx_pr_idempotency', unique: true });
    await queryInterface.addIndex('promotion_redemptions', ['reservationExpiresAt'], { name: 'idx_pr_expiry' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('promotion_redemptions');
  },
};

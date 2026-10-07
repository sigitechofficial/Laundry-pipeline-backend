'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = async (name) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${name}'`
      );
      return rows[0].cnt > 0;
    };

    if (await tableExists('order_adjustments')) return;

    // Every discount/fee applied to an order, with line-level allocation
    await queryInterface.createTable('order_adjustments', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },

      bookingId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'bookings', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },

      // What type of adjustment
      adjustmentClass: {
        type: Sequelize.ENUM(
          'BASE_PRICE',
          'CONTRACT_PRICE',
          'ITEM_PROMOTION',
          'BASKET_PROMOTION',
          'DELIVERY_PROMOTION',
          'COUPON_DISCOUNT',
          'MANUAL_DISCOUNT',
          'TAX',
          'DELIVERY_FEE',
          'SERVICE_FEE',
          'WALLET_CREDIT',
          'GIFT_CARD',
          'REFERRAL_CREDIT',
          'LOYALTY_BENEFIT',
          'RESCHEDULE_FEE',
          'NO_SHOW_FEE',
          'CANCELLATION_FEE',
          'REFUND'
        ),
        allowNull: false,
      },

      // Link to promotion if from promotion engine
      promotionId: { type: Sequelize.INTEGER, allowNull: true },
      promotionVersionId: { type: Sequelize.INTEGER, allowNull: true },
      couponCodeId: { type: Sequelize.INTEGER, allowNull: true },
      couponCode: { type: Sequelize.STRING(50), allowNull: true },

      // What line item this adjustment applies to (null = basket-level)
      lineType: {
        type: Sequelize.ENUM('subCategory', 'addon', 'delivery', 'basket'),
        allowNull: false,
        defaultValue: 'basket',
      },
      lineItemId: { type: Sequelize.INTEGER, allowNull: true, comment: 'subCategory/addon ID for line-level' },
      lineDescription: { type: Sequelize.STRING(200), allowNull: true },

      // Financial values
      amount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, comment: 'Negative = discount, positive = fee/charge' },
      currency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'GBP' },

      // Explanation
      label: { type: Sequelize.STRING(200), allowNull: true, comment: 'e.g. "20% OFF", "Free Delivery"' },
      description: { type: Sequelize.STRING(500), allowNull: true },

      // Audit
      appliedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      appliedBy: { type: Sequelize.STRING(50), allowNull: false, defaultValue: 'system', comment: 'system, admin userId, support userId' },
      reason: { type: Sequelize.STRING(500), allowNull: true, comment: 'Manual discount reason' },

      // For reversals
      reversedAt: { type: Sequelize.DATE, allowNull: true },
      reversedBy: { type: Sequelize.STRING(50), allowNull: true },
      reversalReason: { type: Sequelize.STRING(500), allowNull: true },
      originalAdjustmentId: { type: Sequelize.INTEGER, allowNull: true, comment: 'Links reversal to original' },

      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('order_adjustments', ['bookingId'], { name: 'idx_oa_booking' });
    await queryInterface.addIndex('order_adjustments', ['promotionId'], { name: 'idx_oa_promotion' });
    await queryInterface.addIndex('order_adjustments', ['adjustmentClass'], { name: 'idx_oa_class' });
    await queryInterface.addIndex('order_adjustments', ['bookingId', 'lineType', 'lineItemId'], { name: 'idx_oa_booking_line' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('order_adjustments');
  },
};

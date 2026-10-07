'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = async (name) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${name}'`
      );
      return rows[0].cnt > 0;
    };

    if (await tableExists('promotions')) return;

    await queryInterface.createTable('promotions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },

      campaignId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'campaigns', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },

      name: { type: Sequelize.STRING(200), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      internalNotes: { type: Sequelize.TEXT, allowNull: true, comment: 'Admin-only notes' },

      // Benefit type: what this promotion gives
      benefitType: {
        type: Sequelize.ENUM(
          'percentage_discount',
          'fixed_amount_discount',
          'fixed_price',
          'free_delivery',
          'delivery_discount',
          'item_discount',
          'category_discount',
          'service_discount',
          'basket_discount',
          'cashback',
          'buy_x_get_y',
          'bundle',
          'first_order_discount',
          'first_x_orders_discount'
        ),
        allowNull: false,
      },

      // Core benefit values (detailed config in promotion_versions JSON)
      discountValue: { type: Sequelize.DECIMAL(10, 2), allowNull: true, comment: 'Percentage or fixed amount' },
      maxDiscountCap: { type: Sequelize.DECIMAL(10, 2), allowNull: true, comment: 'Cap for percentage discounts' },
      currency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'GBP' },

      // Target scope: what the promotion applies to
      targetType: {
        type: Sequelize.ENUM('all', 'service', 'category', 'subCategory', 'addon', 'delivery', 'basket'),
        allowNull: false,
        defaultValue: 'basket',
      },
      targetIds: { type: Sequelize.JSON, allowNull: true, comment: 'Array of IDs for targeted scope' },

      // Zone scope
      zoneScopeMode: {
        type: Sequelize.ENUM('all', 'selected', 'excluded'),
        allowNull: false,
        defaultValue: 'all',
      },
      zoneIds: { type: Sequelize.JSON, allowNull: true, comment: 'Zone IDs for selected/excluded mode' },

      // Scheduling
      startDate: { type: Sequelize.DATE, allowNull: true },
      endDate: { type: Sequelize.DATE, allowNull: true },
      recurringDays: { type: Sequelize.JSON, allowNull: true, comment: '[0-6] weekdays, 0=Sunday' },
      recurringStartTime: { type: Sequelize.TIME, allowNull: true },
      recurringEndTime: { type: Sequelize.TIME, allowNull: true },

      // Activation
      activationType: {
        type: Sequelize.ENUM('automatic', 'coupon_required'),
        allowNull: false,
        defaultValue: 'automatic',
      },

      // Visibility (for customer-facing surfaces)
      visibility: {
        type: Sequelize.ENUM('public', 'private_code', 'targeted', 'hidden'),
        allowNull: false,
        defaultValue: 'hidden',
      },

      // Stacking / priority
      priority: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 50, comment: 'Higher = applied first in conflict' },
      stackable: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      stackGroup: { type: Sequelize.STRING(50), allowNull: true, comment: 'Only one per group when not stackable' },

      // Usage limits
      globalUsageLimit: { type: Sequelize.INTEGER, allowNull: true, comment: 'Total redemptions across all customers' },
      perCustomerLimit: { type: Sequelize.INTEGER, allowNull: true, defaultValue: 1, comment: 'Max uses per customer' },
      perDayLimit: { type: Sequelize.INTEGER, allowNull: true },
      perWeekLimit: { type: Sequelize.INTEGER, allowNull: true },

      // Counters (denormalized for fast reads; ledger is source of truth)
      globalUsedCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      globalReservedCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },

      // Minimum order requirements
      minSubtotal: { type: Sequelize.DECIMAL(10, 2), allowNull: true, comment: 'Minimum basket subtotal' },
      maxSubtotal: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      minQuantity: { type: Sequelize.INTEGER, allowNull: true },

      // Repricing policy (for laundry order changes)
      repricingPolicy: {
        type: Sequelize.ENUM('recalculate', 'revalidate', 'lock'),
        allowNull: false,
        defaultValue: 'recalculate',
      },

      // Lifecycle state machine
      status: {
        type: Sequelize.ENUM('draft', 'pending_approval', 'approved', 'scheduled', 'active', 'paused', 'expired', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },

      // Current published version
      currentVersionId: { type: Sequelize.INTEGER, allowNull: true },

      // Metadata
      tags: { type: Sequelize.JSON, allowNull: true },
      createdBy: { type: Sequelize.INTEGER, allowNull: true },
      updatedBy: { type: Sequelize.INTEGER, allowNull: true },

      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('promotions', ['status', 'startDate', 'endDate'], { name: 'idx_promotions_status_dates' });
    await queryInterface.addIndex('promotions', ['campaignId'], { name: 'idx_promotions_campaign' });
    await queryInterface.addIndex('promotions', ['benefitType'], { name: 'idx_promotions_benefit_type' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('promotions');
  },
};

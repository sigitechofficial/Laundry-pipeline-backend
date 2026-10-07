'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = async (name) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${name}'`
      );
      return rows[0].cnt > 0;
    };

    if (await tableExists('promotion_conditions')) return;

    await queryInterface.createTable('promotion_conditions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },

      promotionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'promotions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },

      // Typed condition per the master plan
      conditionType: {
        type: Sequelize.ENUM(
          'ZONE',
          'CUSTOMER_TYPE',
          'CUSTOMER_SEGMENT',
          'FIRST_ORDER',
          'ORDER_COUNT',
          'MINIMUM_SUBTOTAL',
          'MAXIMUM_SUBTOTAL',
          'MINIMUM_QUANTITY',
          'MAXIMUM_QUANTITY',
          'SERVICE',
          'CATEGORY',
          'PRODUCT',
          'ADDON',
          'COLLECTION_DAY',
          'DELIVERY_DAY',
          'BOOKING_TIME',
          'TURNAROUND_TYPE',
          'PAYMENT_METHOD',
          'SCHEDULE',
          'COUPON'
        ),
        allowNull: false,
      },

      // Operator: how to match
      operator: {
        type: Sequelize.ENUM('equals', 'not_equals', 'in', 'not_in', 'gte', 'lte', 'between', 'any'),
        allowNull: false,
        defaultValue: 'equals',
      },

      // Value(s) — typed JSON for flexibility
      value: {
        type: Sequelize.JSON,
        allowNull: false,
        comment: 'Condition value: number, string, or array depending on type',
      },

      // Composition logic: ALL conditions must pass, or ANY
      logicGroup: {
        type: Sequelize.ENUM('ALL', 'ANY'),
        allowNull: false,
        defaultValue: 'ALL',
        comment: 'ALL = AND logic, ANY = OR logic within group',
      },

      // Ordering for evaluation
      sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },

      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('promotion_conditions', ['promotionId'], { name: 'idx_pc_promotion' });
    await queryInterface.addIndex('promotion_conditions', ['conditionType'], { name: 'idx_pc_type' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('promotion_conditions');
  },
};

'use strict';

const { addColumnIfMissing, columnExists, tableExists } = require('../utils/migrationHelpers');

/**
 * Promotions: explicit percent vs amount (no more guessing from the value) and
 * a bounded JSON config for benefit-specific settings (e.g. firstOrders for
 * first_x_orders_discount). Backfills discountMode from benefitType.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'promotions'))) return;

    await addColumnIfMissing(queryInterface, 'promotions', 'discountMode', {
      type: Sequelize.ENUM('percent', 'amount'),
      allowNull: true,
      defaultValue: null,
      comment: 'How discountValue is read. Null = derived from benefitType.',
    });

    await addColumnIfMissing(queryInterface, 'promotions', 'benefitConfig', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: null,
      comment: 'Benefit-specific settings, e.g. { firstOrders: 3 }',
    });

    if (!(await columnExists(queryInterface, 'promotions', 'discountMode'))) return;

    await queryInterface.sequelize.query(`
      UPDATE promotions SET discountMode = 'amount'
      WHERE discountMode IS NULL AND benefitType IN ('fixed_amount_discount', 'delivery_discount', 'fixed_price')
    `);
    await queryInterface.sequelize.query(`
      UPDATE promotions SET discountMode = 'percent'
      WHERE discountMode IS NULL AND benefitType NOT IN ('free_delivery')
    `);
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, 'promotions'))) return;
    if (await columnExists(queryInterface, 'promotions', 'benefitConfig')) {
      await queryInterface.removeColumn('promotions', 'benefitConfig');
    }
    if (await columnExists(queryInterface, 'promotions', 'discountMode')) {
      await queryInterface.removeColumn('promotions', 'discountMode');
    }
  },
};

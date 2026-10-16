'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/**
 * What a promotion was worth on the invoice before the "never more than is still to
 * pay" limit, so the bill can explain a smaller discount (e.g. worth £89, applied £69
 * because £30 was paid at booking). NULL on holds priced before this column existed.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'promotion_redemptions', 'fullDiscountAmount', {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Saving before the payable-balance limit (discountAmount is after it)',
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'promotion_redemptions', 'fullDiscountAmount');
  },
};

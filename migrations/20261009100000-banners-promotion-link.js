'use strict';

const { addColumnIfMissing, columnExists, tableExists } = require('../utils/migrationHelpers');

/**
 * Banners can be linked to a promotion: the badge then comes from the promotion and the
 * banner is only shown while that promotion is live where the customer is.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'banners'))) return;
    await addColumnIfMissing(queryInterface, 'banners', 'promotionId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
      comment: 'Optional linked promotion (badge + visibility follow it)',
    });
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, 'banners'))) return;
    if (await columnExists(queryInterface, 'banners', 'promotionId')) {
      await queryInterface.removeColumn('banners', 'promotionId');
    }
  },
};

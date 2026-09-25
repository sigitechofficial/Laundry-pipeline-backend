'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/**
 * Coupons can target all zones (null / []) or a JSON list of zone ids.
 * Same pattern as banners.zoneIds.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'coupons', 'zoneIds', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: null,
      comment: 'null or [] = all zones; otherwise array of zone ids',
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'coupons', 'zoneIds');
  },
};

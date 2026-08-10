'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'customerSelectedServiceAddOns', 'items', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 1,
    });
  },
  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'customerSelectedServiceAddOns', 'items');
  },
};

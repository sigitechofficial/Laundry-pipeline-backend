'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'services', 'numberOfBags', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await addColumnIfMissing(queryInterface, 'services', 'numberOfItems', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'services', 'numberOfItems');
    await removeColumnIfExists(queryInterface, 'services', 'numberOfBags');
  },
};

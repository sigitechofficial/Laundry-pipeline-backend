'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(
      queryInterface,
      'bookingPreferences',
      'preferenceInstruction',
      {
        type: Sequelize.TEXT,
        allowNull: true,
      }
    );
  },
  async down(queryInterface) {
    await removeColumnIfExists(
      queryInterface,
      'bookingPreferences',
      'preferenceInstruction'
    );
  },
};

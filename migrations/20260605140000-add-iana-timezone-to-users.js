'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'users', 'ianaTimeZone', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'users', 'ianaTimeZone');
  },
};

'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'customerSelectedServices', 'bags', {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
  },
  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'customerSelectedServices', 'bags');
  },
};

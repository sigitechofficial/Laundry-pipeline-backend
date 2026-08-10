'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Column may already exist from create-customer-selected-service (greenfield).
    await addColumnIfMissing(
      queryInterface,
      'customerSelectedServices',
      'serviceInstruction',
      {
        type: Sequelize.TEXT,
        allowNull: true,
      }
    );
  },
  async down(queryInterface) {
    await removeColumnIfExists(
      queryInterface,
      'customerSelectedServices',
      'serviceInstruction'
    );
  },
};

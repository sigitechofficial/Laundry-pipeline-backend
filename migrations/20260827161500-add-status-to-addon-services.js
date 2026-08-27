'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'addOnServices', 'status', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'Controls add-on visibility in customer/agent apps',
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'addOnServices', 'status');
  },
};

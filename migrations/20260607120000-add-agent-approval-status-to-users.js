'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'users', 'agentApprovalStatus', {
      type: Sequelize.ENUM('pending', 'approved', 'rejected'),
      allowNull: false,
      defaultValue: 'approved',
    });
    await addColumnIfMissing(queryInterface, 'users', 'rejectionReason', {
      type: Sequelize.STRING(500),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'users', 'rejectionReason');
    await removeColumnIfExists(queryInterface, 'users', 'agentApprovalStatus');
  },
};

'use strict';

const { tableExists, addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'attempt_fail_reasons'))) return;
    await addColumnIfMissing(queryInterface, 'attempt_fail_reasons', 'requiresCompliance', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, 'attempt_fail_reasons'))) return;
    await removeColumnIfExists(queryInterface, 'attempt_fail_reasons', 'requiresCompliance');
  },
};

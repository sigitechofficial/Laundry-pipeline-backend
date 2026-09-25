'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/**
 * Per-shop override for "max orders acceptables in a rolling time window".
 * Global defaults live in platformRuntimeSettings (shopAcceptCap*).
 * NULL override → inherit global (when enabled).
 *
 * acceptMaxOrders = 0 → shop gets no new marketplace offers (admin assign still OK).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'shopAssignmentPolicies', 'acceptCapOverride', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'When true, use shop acceptWindowMinutes/acceptMaxOrders instead of global',
    });
    await addColumnIfMissing(queryInterface, 'shopAssignmentPolicies', 'acceptWindowMinutes', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
      comment: 'Rolling window in minutes when acceptCapOverride=true',
    });
    await addColumnIfMissing(queryInterface, 'shopAssignmentPolicies', 'acceptMaxOrders', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
      comment: 'Max accepts in window when override=true; 0 = none via marketplace',
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'shopAssignmentPolicies', 'acceptMaxOrders');
    await removeColumnIfExists(queryInterface, 'shopAssignmentPolicies', 'acceptWindowMinutes');
    await removeColumnIfExists(queryInterface, 'shopAssignmentPolicies', 'acceptCapOverride');
  },
};

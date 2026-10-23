'use strict';

const {
  tableExists,
  addColumnIfMissing,
  removeColumnIfExists,
} = require('../utils/migrationHelpers');

/**
 * New-shop order ramp. Idempotent so ensure-live-migrations can heal a
 * database whose SequelizeMeta says this already ran.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'addressDbs', 'revenueRampEligible', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Shop was created while the new-shop revenue ramp covered its zone',
    });
    await addColumnIfMissing(queryInterface, 'addressDbs', 'revenueRampOrdersTaken', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'How many of this shop orders have been sequenced on the ramp',
    });
    await addColumnIfMissing(queryInterface, 'bookings', 'revenueRampStep', {
      type: Sequelize.INTEGER,
      allowNull: true,
      comment: '1 admin 100%, 2 split 50/50, 3 shop 100%, 4+ normal zone commission',
    });

    if (!(await tableExists(queryInterface, 'revenueRampPolicies'))) {
      await queryInterface.createTable('revenueRampPolicies', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        enabled: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        applyToAllZones: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        zoneIds: {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },
      });
    }
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'addressDbs', 'revenueRampEligible');
    await removeColumnIfExists(queryInterface, 'addressDbs', 'revenueRampOrdersTaken');
    await removeColumnIfExists(queryInterface, 'bookings', 'revenueRampStep');
    if (await tableExists(queryInterface, 'revenueRampPolicies')) {
      await queryInterface.dropTable('revenueRampPolicies');
    }
  },
};

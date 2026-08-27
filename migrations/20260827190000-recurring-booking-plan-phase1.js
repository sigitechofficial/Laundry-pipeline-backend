'use strict';

const {
  tableExists,
  addColumnIfMissing,
  removeColumnIfExists,
} = require('../utils/migrationHelpers');

async function indexExists(queryInterface, tableName, indexName) {
  try {
    const indexes = await queryInterface.showIndex(tableName);
    return (indexes || []).some((idx) => idx?.name === indexName);
  } catch (_) {
    return false;
  }
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'recurringPlans'))) {
      await queryInterface.createTable('recurringPlans', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        customerId: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },
        sourceBookingId: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },
        frequency: {
          type: Sequelize.ENUM(
            'Just Once',
            'Weekly',
            'Every two weeks',
            'Every four weeks'
          ),
          allowNull: false,
          defaultValue: 'Just Once',
        },
        status: {
          type: Sequelize.ENUM('active', 'paused', 'cancelled'),
          allowNull: false,
          defaultValue: 'active',
        },
        nextRunAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        lastGeneratedFromBookingId: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },
        lastGeneratedAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        failureCount: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        maxFailures: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 3,
        },
        notes: {
          type: Sequelize.STRING(500),
          allowNull: true,
        },
        createdAt: {
          allowNull: false,
          type: Sequelize.DATE,
        },
        updatedAt: {
          allowNull: false,
          type: Sequelize.DATE,
        },
      });
    }

    await addColumnIfMissing(queryInterface, 'bookings', 'recurringPlanId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'bookings', 'recurringSourceBookingId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'bookings', 'recurringNextBookingId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'bookings', 'recurringCycleDate', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'bookings', 'isRecurringAutoCreated', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    if (!(await indexExists(queryInterface, 'recurringPlans', 'uniq_recurring_source_booking'))) {
      await queryInterface.addIndex('recurringPlans', ['sourceBookingId'], {
        name: 'uniq_recurring_source_booking',
        unique: true,
      });
    }
    if (!(await indexExists(queryInterface, 'bookings', 'idx_bookings_recurring_plan'))) {
      await queryInterface.addIndex('bookings', ['recurringPlanId'], {
        name: 'idx_bookings_recurring_plan',
      });
    }
    if (!(await indexExists(queryInterface, 'bookings', 'idx_bookings_recurring_source'))) {
      await queryInterface.addIndex('bookings', ['recurringSourceBookingId'], {
        name: 'idx_bookings_recurring_source',
      });
    }
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'bookings', 'isRecurringAutoCreated');
    await removeColumnIfExists(queryInterface, 'bookings', 'recurringCycleDate');
    await removeColumnIfExists(queryInterface, 'bookings', 'recurringNextBookingId');
    await removeColumnIfExists(queryInterface, 'bookings', 'recurringSourceBookingId');
    await removeColumnIfExists(queryInterface, 'bookings', 'recurringPlanId');

    if (await tableExists(queryInterface, 'recurringPlans')) {
      await queryInterface.dropTable('recurringPlans');
    }

    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_recurringPlans_status";').catch(() => {});
    await queryInterface.sequelize
      .query('DROP TYPE IF EXISTS "enum_recurringPlans_frequency";')
      .catch(() => {});
  },
};

'use strict';

const { tableExists, addColumnIfMissing } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'attempt_fail_instruction_sets'))) {
      await queryInterface.createTable('attempt_fail_instruction_sets', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        scope: {
          type: Sequelize.ENUM('pickup', 'delivery'),
          allowNull: false,
        },
        name: {
          type: Sequelize.STRING(120),
          allowNull: false,
        },
        zoneId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'zones', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
          comment: 'Null = global default set for scope',
        },
        isActive: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        version: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1,
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      });
      await queryInterface.addIndex('attempt_fail_instruction_sets', ['scope', 'zoneId', 'isActive'], {
        name: 'fail_instruction_sets_scope_zone_active',
      });
    }

    if (!(await tableExists(queryInterface, 'attempt_fail_instructions'))) {
      await queryInterface.createTable('attempt_fail_instructions', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        setId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'attempt_fail_instruction_sets', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        title: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        body: {
          type: Sequelize.STRING(1000),
          allowNull: true,
        },
        sortOrder: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        isEnabled: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        isRequired: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      });
      await queryInterface.addIndex('attempt_fail_instructions', ['setId', 'sortOrder'], {
        name: 'fail_instructions_set_sort',
      });
    }

    if (!(await tableExists(queryInterface, 'agent_compliance_events'))) {
      await queryInterface.createTable('agent_compliance_events', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        bookingId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'bookings', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        actorUserId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        shopId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        action: {
          type: Sequelize.ENUM(
            'arrived_pickup',
            'arrived_delivery',
            'complete_pickup',
            'complete_delivery',
            'fail_pickup',
            'fail_delivery'
          ),
          allowNull: false,
        },
        withinGeofence: {
          type: Sequelize.BOOLEAN,
          allowNull: true,
        },
        overrideUsed: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        geofenceBypassedGlobal: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        driverLat: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
        driverLng: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
        customerLat: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
        customerLng: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
        distanceMeters: { type: Sequelize.INTEGER, allowNull: true },
        requiredRadiusMeters: { type: Sequelize.INTEGER, allowNull: true },
        failInstructionSetId: { type: Sequelize.INTEGER, allowNull: true },
        failInstructionSetVersion: { type: Sequelize.INTEGER, allowNull: true },
        acknowledgedItemSnapshot: { type: Sequelize.JSON, allowNull: true },
        overrideReason: { type: Sequelize.STRING(500), allowNull: true },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      });
      await queryInterface.addIndex('agent_compliance_events', ['bookingId', 'action'], {
        name: 'compliance_events_booking_action',
      });
      await queryInterface.addIndex('agent_compliance_events', ['actorUserId', 'createdAt'], {
        name: 'compliance_events_actor_created',
      });
      await queryInterface.addIndex('agent_compliance_events', ['shopId', 'createdAt'], {
        name: 'compliance_events_shop_created',
      });
      await queryInterface.addIndex('agent_compliance_events', ['overrideUsed', 'createdAt'], {
        name: 'compliance_events_override_created',
      });
    }

    const bookingFlags = [
      'pickupArrivedGeofenceOverride',
      'deliveryArrivedGeofenceOverride',
      'pickupCompleteGeofenceOverride',
      'deliveryCompleteGeofenceOverride',
    ];
    for (const col of bookingFlags) {
      await addColumnIfMissing(queryInterface, 'bookings', col, {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }
  },

  async down(queryInterface) {
    const { removeColumnIfExists, tableExists } = require('../utils/migrationHelpers');
    for (const col of [
      'pickupArrivedGeofenceOverride',
      'deliveryArrivedGeofenceOverride',
      'pickupCompleteGeofenceOverride',
      'deliveryCompleteGeofenceOverride',
    ]) {
      await removeColumnIfExists(queryInterface, 'bookings', col);
    }
    if (await tableExists(queryInterface, 'agent_compliance_events')) {
      await queryInterface.dropTable('agent_compliance_events');
    }
    if (await tableExists(queryInterface, 'attempt_fail_instructions')) {
      await queryInterface.dropTable('attempt_fail_instructions');
    }
    if (await tableExists(queryInterface, 'attempt_fail_instruction_sets')) {
      await queryInterface.dropTable('attempt_fail_instruction_sets');
    }
  },
};

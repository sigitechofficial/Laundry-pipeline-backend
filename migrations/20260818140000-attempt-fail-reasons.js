'use strict';

const { tableExists, addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'attempt_fail_reasons'))) {
      await queryInterface.createTable('attempt_fail_reasons', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        code: {
          type: Sequelize.STRING(64),
          allowNull: false,
          unique: true,
        },
        label: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        description: {
          type: Sequelize.STRING(500),
          allowNull: true,
        },
        scope: {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'both',
        },
        chargesFee: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        requiresNote: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        isOther: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        sortOrder: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        status: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      });
      await queryInterface.addIndex('attempt_fail_reasons', ['scope', 'status', 'sortOrder'], {
        name: 'attempt_fail_reasons_scope_status_sort',
      });
    }

    if (await tableExists(queryInterface, 'booking_attempts')) {
      await addColumnIfMissing(queryInterface, 'booking_attempts', 'failureReasonId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'attempt_fail_reasons', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
      await addColumnIfMissing(queryInterface, 'booking_attempts', 'failureReasonCode', {
        type: Sequelize.STRING(64),
        allowNull: true,
      });
      await addColumnIfMissing(queryInterface, 'booking_attempts', 'failureReasonNote', {
        type: Sequelize.STRING(500),
        allowNull: true,
      });
      await addColumnIfMissing(queryInterface, 'booking_attempts', 'failureChargesFee', {
        type: Sequelize.BOOLEAN,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'booking_attempts')) {
      await removeColumnIfExists(queryInterface, 'booking_attempts', 'failureChargesFee');
      await removeColumnIfExists(queryInterface, 'booking_attempts', 'failureReasonNote');
      await removeColumnIfExists(queryInterface, 'booking_attempts', 'failureReasonCode');
      await removeColumnIfExists(queryInterface, 'booking_attempts', 'failureReasonId');
    }
    if (await tableExists(queryInterface, 'attempt_fail_reasons')) {
      await queryInterface.dropTable('attempt_fail_reasons');
    }
  },
};

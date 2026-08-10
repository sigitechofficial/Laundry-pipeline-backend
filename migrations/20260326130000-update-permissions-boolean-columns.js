'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDefinition = await queryInterface.describeTable('permissions');

    // Add new boolean columns
    if (!tableDefinition.create) {
      await addColumnIfMissing(queryInterface, 'permissions', 'create', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    if (!tableDefinition.update) {
      await addColumnIfMissing(queryInterface, 'permissions', 'update', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    if (!tableDefinition.delete) {
      await addColumnIfMissing(queryInterface, 'permissions', 'delete', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    // Drop legacy columns
    if (tableDefinition.permissionType) {
      await removeColumnIfExists(queryInterface, 'permissions', 'permissionType');
    }

    if (tableDefinition.write) {
      await removeColumnIfExists(queryInterface, 'permissions', 'write');
    }
  },

  async down(queryInterface, Sequelize) {
    const tableDefinition = await queryInterface.describeTable('permissions');

    if (!tableDefinition.permissionType) {
      await addColumnIfMissing(queryInterface, 'permissions', 'permissionType', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }

    if (!tableDefinition.write) {
      await addColumnIfMissing(queryInterface, 'permissions', 'write', {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      });
    }

    if (tableDefinition.create) {
      await removeColumnIfExists(queryInterface, 'permissions', 'create');
    }

    if (tableDefinition.update) {
      await removeColumnIfExists(queryInterface, 'permissions', 'update');
    }

    if (tableDefinition.delete) {
      await removeColumnIfExists(queryInterface, 'permissions', 'delete');
    }
  }
};

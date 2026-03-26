'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDefinition = await queryInterface.describeTable('permissions');

    // Add new boolean columns
    if (!tableDefinition.create) {
      await queryInterface.addColumn('permissions', 'create', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    if (!tableDefinition.update) {
      await queryInterface.addColumn('permissions', 'update', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    if (!tableDefinition.delete) {
      await queryInterface.addColumn('permissions', 'delete', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    // Drop legacy columns
    if (tableDefinition.permissionType) {
      await queryInterface.removeColumn('permissions', 'permissionType');
    }

    if (tableDefinition.write) {
      await queryInterface.removeColumn('permissions', 'write');
    }
  },

  async down(queryInterface, Sequelize) {
    const tableDefinition = await queryInterface.describeTable('permissions');

    if (!tableDefinition.permissionType) {
      await queryInterface.addColumn('permissions', 'permissionType', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }

    if (!tableDefinition.write) {
      await queryInterface.addColumn('permissions', 'write', {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      });
    }

    if (tableDefinition.create) {
      await queryInterface.removeColumn('permissions', 'create');
    }

    if (tableDefinition.update) {
      await queryInterface.removeColumn('permissions', 'update');
    }

    if (tableDefinition.delete) {
      await queryInterface.removeColumn('permissions', 'delete');
    }
  }
};

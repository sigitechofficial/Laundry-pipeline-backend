'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDefinition = await queryInterface.describeTable('permissions');

    if (!tableDefinition.featureId) {
      await addColumnIfMissing(queryInterface, 'permissions', 'featureId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'features',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      });
    }

    if (!tableDefinition.roleId) {
      await addColumnIfMissing(queryInterface, 'permissions', 'roleId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'roles',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      });
    }

  },

  async down(queryInterface) {
    const tableDefinition = await queryInterface.describeTable('permissions');

    if (tableDefinition.roleId) {
      await removeColumnIfExists(queryInterface, 'permissions', 'roleId');
    }
    if (tableDefinition.featureId) {
      await removeColumnIfExists(queryInterface, 'permissions', 'featureId');
    }
  }
};

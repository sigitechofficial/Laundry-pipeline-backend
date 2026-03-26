'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDefinition = await queryInterface.describeTable('permissions');

    if (!tableDefinition.featureId) {
      await queryInterface.addColumn('permissions', 'featureId', {
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
      await queryInterface.addColumn('permissions', 'roleId', {
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
      await queryInterface.removeColumn('permissions', 'roleId');
    }
    if (tableDefinition.featureId) {
      await queryInterface.removeColumn('permissions', 'featureId');
    }
  }
};

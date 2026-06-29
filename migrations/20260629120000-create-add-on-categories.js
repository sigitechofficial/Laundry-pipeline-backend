'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('addOnCategories', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false
      },
      status: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      deletedAt: {
        allowNull: true,
        type: Sequelize.DATE
      }
    });

    const addOnServicesTable = await queryInterface.describeTable('addOnServices');
    if (!addOnServicesTable.addOnCategoryId) {
      await queryInterface.addColumn('addOnServices', 'addOnCategoryId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'addOnCategories', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      });
    }
  },

  async down(queryInterface) {
    const addOnServicesTable = await queryInterface.describeTable('addOnServices');
    if (addOnServicesTable.addOnCategoryId) {
      await queryInterface.removeColumn('addOnServices', 'addOnCategoryId');
    }
    await queryInterface.dropTable('addOnCategories');
  }
};

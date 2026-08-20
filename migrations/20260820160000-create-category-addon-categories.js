'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, 'categoryAddOnCategories')) {
      return;
    }

    await queryInterface.createTable('categoryAddOnCategories', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      categoryId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'categories', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      addOnCategoryId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'addOnCategories', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      createdAt: { allowNull: false, type: Sequelize.DATE },
      updatedAt: { allowNull: false, type: Sequelize.DATE },
    });

    await queryInterface.addIndex(
      'categoryAddOnCategories',
      ['categoryId', 'addOnCategoryId'],
      { unique: true, name: 'cat_addoncat_unique' }
    );
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'categoryAddOnCategories')) {
      await queryInterface.dropTable('categoryAddOnCategories');
    }
  },
};

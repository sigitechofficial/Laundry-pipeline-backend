'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, 'subCategoryExcludedAddOnCategories')) {
      return;
    }

    await queryInterface.createTable('subCategoryExcludedAddOnCategories', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      subCategoryId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'subCategories', key: 'id' },
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
      'subCategoryExcludedAddOnCategories',
      ['subCategoryId', 'addOnCategoryId'],
      { unique: true, name: 'subcat_excluded_addoncat_unique' }
    );
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'subCategoryExcludedAddOnCategories')) {
      await queryInterface.dropTable('subCategoryExcludedAddOnCategories');
    }
  },
};

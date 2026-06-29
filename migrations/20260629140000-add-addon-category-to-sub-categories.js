'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('subCategories');
    if (!table.addOnCategoryId) {
      await queryInterface.addColumn('subCategories', 'addOnCategoryId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'addOnCategories', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('subCategories');
    if (table.addOnCategoryId) {
      await queryInterface.removeColumn('subCategories', 'addOnCategoryId');
    }
  }
};

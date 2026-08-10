'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'subCategories', 'addOnCategoryId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'addOnCategories', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      });
  },
  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'subCategories', 'addOnCategoryId');
  },
};

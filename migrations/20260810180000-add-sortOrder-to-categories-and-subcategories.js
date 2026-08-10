'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'categories', 'sortOrder', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Display order within a service (lower = first)',
    });

    await addColumnIfMissing(queryInterface, 'subCategories', 'sortOrder', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Display order within a category (lower = first)',
    });

    // Backfill: use id as a stable initial order (works on MySQL 5.7+)
    await queryInterface.sequelize.query(`
      UPDATE categories SET sortOrder = id WHERE sortOrder = 0 OR sortOrder IS NULL
    `);
    await queryInterface.sequelize.query(`
      UPDATE subCategories SET sortOrder = id WHERE sortOrder = 0 OR sortOrder IS NULL
    `);
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'subCategories', 'sortOrder');
    await removeColumnIfExists(queryInterface, 'categories', 'sortOrder');
  },
};

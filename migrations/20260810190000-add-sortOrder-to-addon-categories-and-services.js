'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'addOnCategories', 'sortOrder', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Display order of add-on categories (lower = first)',
    });

    await addColumnIfMissing(queryInterface, 'addOnServices', 'sortOrder', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Display order within an add-on category (lower = first)',
    });

    await queryInterface.sequelize.query(`
      UPDATE addOnCategories SET sortOrder = id WHERE sortOrder = 0 OR sortOrder IS NULL
    `);
    await queryInterface.sequelize.query(`
      UPDATE addOnServices SET sortOrder = id WHERE sortOrder = 0 OR sortOrder IS NULL
    `);
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'addOnServices', 'sortOrder');
    await removeColumnIfExists(queryInterface, 'addOnCategories', 'sortOrder');
  },
};

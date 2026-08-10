'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'subCategories', 'unitCount', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null
    });
  },
  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'subCategories', 'unitCount');
  },
};

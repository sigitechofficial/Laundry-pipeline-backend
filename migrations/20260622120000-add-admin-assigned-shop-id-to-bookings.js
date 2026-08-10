'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'bookings', 'adminAssignedShopId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment:
          "Admin-target shop address id; booking pending accept by that shop only",
      });
  },
  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'bookings', 'adminAssignedShopId');
  },
};

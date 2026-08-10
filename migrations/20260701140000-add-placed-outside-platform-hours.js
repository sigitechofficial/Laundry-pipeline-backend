'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'bookings', 'placedOutsidePlatformHours', {
                    type: Sequelize.BOOLEAN,
                    allowNull: false,
                    defaultValue: false,
                });
  },
  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'bookings', 'placedOutsidePlatformHours');
  },
};

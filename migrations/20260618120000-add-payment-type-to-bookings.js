'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'bookings', 'paymentType', {
      type: Sequelize.ENUM('card', 'cash'),
      allowNull: false,
      defaultValue: 'card',
    });
  },
  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'bookings', 'paymentType');
  },
};

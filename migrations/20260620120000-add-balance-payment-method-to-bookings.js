'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'bookings', 'balancePaymentMethod', {
      type: Sequelize.ENUM('card', 'cash'),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'bookings', 'balanceCollectedVia', {
      type: Sequelize.ENUM('card', 'cash'),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'bookings', 'balanceCollectedVia');
    await removeColumnIfExists(queryInterface, 'bookings', 'balancePaymentMethod');
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_bookings_balanceCollectedVia";'
    );
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_bookings_balancePaymentMethod";'
    );
  },
};

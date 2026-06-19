'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('bookings', 'balancePaymentMethod', {
      type: Sequelize.ENUM('card', 'cash'),
      allowNull: true,
    });
    await queryInterface.addColumn('bookings', 'balanceCollectedVia', {
      type: Sequelize.ENUM('card', 'cash'),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('bookings', 'balanceCollectedVia');
    await queryInterface.removeColumn('bookings', 'balancePaymentMethod');
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_bookings_balanceCollectedVia";'
    );
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_bookings_balancePaymentMethod";'
    );
  },
};

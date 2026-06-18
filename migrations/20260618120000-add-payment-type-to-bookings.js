'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('bookings', 'paymentType', {
      type: Sequelize.ENUM('card', 'cash'),
      allowNull: false,
      defaultValue: 'card',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('bookings', 'paymentType');
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_bookings_paymentType";'
    );
  },
};

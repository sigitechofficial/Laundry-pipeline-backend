"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("bookings", "totalBags", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn("bookings", "sameBagForAllServices", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("bookings", "sameBagForAllServices");
    await queryInterface.removeColumn("bookings", "totalBags");
  },
};

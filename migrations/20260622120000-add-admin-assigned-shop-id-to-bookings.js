"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("bookings");

    if (!table.adminAssignedShopId) {
      await queryInterface.addColumn("bookings", "adminAssignedShopId", {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment:
          "Admin-target shop address id; booking pending accept by that shop only",
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("bookings");

    if (table.adminAssignedShopId) {
      await queryInterface.removeColumn("bookings", "adminAssignedShopId");
    }
  },
};

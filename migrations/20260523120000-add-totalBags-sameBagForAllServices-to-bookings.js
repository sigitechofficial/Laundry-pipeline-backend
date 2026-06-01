"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("bookings");

    if (!table.totalBags) {
      await queryInterface.addColumn("bookings", "totalBags", {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }

    if (!table.sameBagForAllServices) {
      await queryInterface.addColumn("bookings", "sameBagForAllServices", {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      });
    }

    if (table.noOfBags) {
      await queryInterface.sequelize.query(`
        UPDATE bookings
        SET totalBags = noOfBags
        WHERE totalBags IS NULL AND noOfBags IS NOT NULL
      `);
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("bookings");

    if (table.sameBagForAllServices) {
      await queryInterface.removeColumn("bookings", "sameBagForAllServices");
    }
    if (table.totalBags) {
      await queryInterface.removeColumn("bookings", "totalBags");
    }
  },
};

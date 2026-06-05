"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("bookings");

    if (!table.operationalTimeZone) {
      await queryInterface.addColumn("bookings", "operationalTimeZone", {
        type: Sequelize.STRING(64),
        allowNull: true,
      });
    }

    if (!table.customerLocalTimeZone) {
      await queryInterface.addColumn("bookings", "customerLocalTimeZone", {
        type: Sequelize.STRING(64),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("bookings");

    if (table.customerLocalTimeZone) {
      await queryInterface.removeColumn("bookings", "customerLocalTimeZone");
    }
    if (table.operationalTimeZone) {
      await queryInterface.removeColumn("bookings", "operationalTimeZone");
    }
  },
};

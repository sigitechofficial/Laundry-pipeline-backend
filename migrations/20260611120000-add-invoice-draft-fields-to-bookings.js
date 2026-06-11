"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("bookings");

    if (!table.invoiceStatus) {
      await queryInterface.addColumn("bookings", "invoiceStatus", {
        type: Sequelize.ENUM("none", "draft", "finalized"),
        allowNull: false,
        defaultValue: "none",
      });
    }

    if (!table.invoiceDraftSavedAt) {
      await queryInterface.addColumn("bookings", "invoiceDraftSavedAt", {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("bookings");

    if (table.invoiceDraftSavedAt) {
      await queryInterface.removeColumn("bookings", "invoiceDraftSavedAt");
    }

    if (table.invoiceStatus) {
      await queryInterface.removeColumn("bookings", "invoiceStatus");
    }
  },
};

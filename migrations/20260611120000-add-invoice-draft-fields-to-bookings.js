"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("bookings");

    if (!table.invoiceStatus) {
      await addColumnIfMissing(queryInterface, "bookings", "invoiceStatus", {
        type: Sequelize.ENUM("none", "draft", "finalized"),
        allowNull: false,
        defaultValue: "none",
      });
    }

    if (!table.invoiceDraftSavedAt) {
      await addColumnIfMissing(queryInterface, "bookings", "invoiceDraftSavedAt", {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("bookings");

    if (table.invoiceDraftSavedAt) {
      await removeColumnIfExists(queryInterface, "bookings", "invoiceDraftSavedAt");
    }

    if (table.invoiceStatus) {
      await removeColumnIfExists(queryInterface, "bookings", "invoiceStatus");
    }
  },
};

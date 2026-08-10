"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("bookings");

    if (!table.operationalTimeZone) {
      await addColumnIfMissing(queryInterface, "bookings", "operationalTimeZone", {
        type: Sequelize.STRING(64),
        allowNull: true,
      });
    }

    if (!table.customerLocalTimeZone) {
      await addColumnIfMissing(queryInterface, "bookings", "customerLocalTimeZone", {
        type: Sequelize.STRING(64),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("bookings");

    if (table.customerLocalTimeZone) {
      await removeColumnIfExists(queryInterface, "bookings", "customerLocalTimeZone");
    }
    if (table.operationalTimeZone) {
      await removeColumnIfExists(queryInterface, "bookings", "operationalTimeZone");
    }
  },
};

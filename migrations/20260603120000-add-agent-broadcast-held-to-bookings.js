"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("bookings");

    if (!table.agentBroadcastHeld) {
      await addColumnIfMissing(queryInterface, "bookings", "agentBroadcastHeld", {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    if (!table.agentVisibleAt) {
      await addColumnIfMissing(queryInterface, "bookings", "agentVisibleAt", {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("bookings");

    if (table.agentVisibleAt) {
      await removeColumnIfExists(queryInterface, "bookings", "agentVisibleAt");
    }
    if (table.agentBroadcastHeld) {
      await removeColumnIfExists(queryInterface, "bookings", "agentBroadcastHeld");
    }
  },
};

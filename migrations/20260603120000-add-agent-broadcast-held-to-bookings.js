"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("bookings");

    if (!table.agentBroadcastHeld) {
      await queryInterface.addColumn("bookings", "agentBroadcastHeld", {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    if (!table.agentVisibleAt) {
      await queryInterface.addColumn("bookings", "agentVisibleAt", {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("bookings");

    if (table.agentVisibleAt) {
      await queryInterface.removeColumn("bookings", "agentVisibleAt");
    }
    if (table.agentBroadcastHeld) {
      await queryInterface.removeColumn("bookings", "agentBroadcastHeld");
    }
  },
};

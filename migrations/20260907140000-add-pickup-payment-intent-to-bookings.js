"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require("../utils/migrationHelpers");

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, "bookings", "pickupPaymentIntentId", {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, "bookings", "pickupPaymentIntentId");
  },
};

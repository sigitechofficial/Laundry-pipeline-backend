"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require("../utils/migrationHelpers");

/**
 * Tip collected in the pickup auth hold (card). Invoice-time tip increases
 * can then be added to amount due without treating them as already paid.
 * Idempotent — safe for ensure-live-migrations re-run.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, "billingDetails", "prepaidTipAmount", {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, "billingDetails", "prepaidTipAmount");
  },
};

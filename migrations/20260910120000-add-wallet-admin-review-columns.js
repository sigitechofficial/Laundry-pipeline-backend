"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require("../utils/migrationHelpers");

/**
 * Admin review metadata for pending wallet rows (withdrawal requests / remittances).
 * Idempotent — safe for ensure-live-migrations re-run.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, "wallets", "reviewedByAdminId", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, "wallets", "reviewedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, "wallets", "adminNote", {
      type: Sequelize.STRING(500),
      allowNull: true,
    });

    try {
      await queryInterface.addIndex("wallets", {
        name: "wallets_withdrawal_pending_idx",
        fields: ["referenceType", "status", "createdAt"],
      });
    } catch (err) {
      if (!/Duplicate|already exists/i.test(String(err.message || ""))) {
        throw err;
      }
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.removeIndex("wallets", "wallets_withdrawal_pending_idx");
    } catch (_) {
      /* ignore */
    }
    await removeColumnIfExists(queryInterface, "wallets", "adminNote");
    await removeColumnIfExists(queryInterface, "wallets", "reviewedAt");
    await removeColumnIfExists(queryInterface, "wallets", "reviewedByAdminId");
  },
};

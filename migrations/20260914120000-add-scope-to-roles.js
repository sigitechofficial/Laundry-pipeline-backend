"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require("../utils/migrationHelpers");

/**
 * Role zone vs platform staff:
 *   zone     — Zone Manager (system role 7): JWT zone is forced
 *   platform — Admin Manager / custom admin roles: all zones, still feature CRUD
 * Idempotent — safe for ensure-live-migrations re-run.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, "roles", "scope", {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: "platform",
    });

    // Zone Manager is always zone-forced. Do not reset custom role scopes on re-run.
    await queryInterface.sequelize.query(
      `UPDATE roles SET scope = 'zone' WHERE id = 7`
    );
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, "roles", "scope");
  },
};

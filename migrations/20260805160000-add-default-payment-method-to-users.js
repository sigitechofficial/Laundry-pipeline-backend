"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, "users", "defaultPaymentMethodId", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, "users", "cardBrand", {
      type: Sequelize.STRING(32),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, "users", "cardLast4", {
      type: Sequelize.STRING(4),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, "users", "cardExpMonth", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, "users", "cardExpYear", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, "users", "cardUpdatedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, "users", "cardUpdatedAt");
    await removeColumnIfExists(queryInterface, "users", "cardExpYear");
    await removeColumnIfExists(queryInterface, "users", "cardExpMonth");
    await removeColumnIfExists(queryInterface, "users", "cardLast4");
    await removeColumnIfExists(queryInterface, "users", "cardBrand");
    await removeColumnIfExists(queryInterface, "users", "defaultPaymentMethodId");
  },
};

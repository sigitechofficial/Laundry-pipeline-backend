"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "defaultPaymentMethodId", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn("users", "cardBrand", {
      type: Sequelize.STRING(32),
      allowNull: true,
    });
    await queryInterface.addColumn("users", "cardLast4", {
      type: Sequelize.STRING(4),
      allowNull: true,
    });
    await queryInterface.addColumn("users", "cardExpMonth", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn("users", "cardExpYear", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn("users", "cardUpdatedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("users", "cardUpdatedAt");
    await queryInterface.removeColumn("users", "cardExpYear");
    await queryInterface.removeColumn("users", "cardExpMonth");
    await queryInterface.removeColumn("users", "cardLast4");
    await queryInterface.removeColumn("users", "cardBrand");
    await queryInterface.removeColumn("users", "defaultPaymentMethodId");
  },
};

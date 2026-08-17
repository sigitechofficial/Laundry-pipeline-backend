"use strict";

const { tableExists } = require("../utils/migrationHelpers");

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, "platformRuntimeSettings")) return;

    await queryInterface.createTable("platformRuntimeSettings", {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      settingKey: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true,
      },
      settingValue: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      valueType: {
        type: Sequelize.ENUM("boolean", "integer"),
        allowNull: false,
        defaultValue: "boolean",
      },
      label: {
        type: Sequelize.STRING(160),
        allowNull: false,
      },
      description: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      settingGroup: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: "ops",
      },
      envKey: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      updatedBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, "platformRuntimeSettings"))) return;
    await queryInterface.dropTable("platformRuntimeSettings");
  },
};

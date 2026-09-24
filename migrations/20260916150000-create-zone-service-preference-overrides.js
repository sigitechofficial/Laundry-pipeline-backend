"use strict";

const {
  tableExists,
  addColumnIfMissing,
} = require("../utils/migrationHelpers");

async function ensureIndex(queryInterface, tableName, fields, name, unique = false) {
  try {
    await queryInterface.addIndex(tableName, fields, { name, unique });
  } catch (err) {
    if (!/exists|duplicate/i.test(err?.message || "")) throw err;
  }
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableName = "zoneServicePreferenceOverrides";

    if (!(await tableExists(queryInterface, tableName))) {
      await queryInterface.createTable(tableName, {
        id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          primaryKey: true,
          autoIncrement: true,
        },
        zoneId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "zones", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        serviceId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "services", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        preferenceTypeId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "preferenceTypes", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        isEnabled: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        sortOrder: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },
        version: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1,
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        deletedAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },
      });
    } else {
      await addColumnIfMissing(queryInterface, tableName, "zoneId", {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "zones", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      });
      await addColumnIfMissing(queryInterface, tableName, "serviceId", {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "services", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      });
      await addColumnIfMissing(queryInterface, tableName, "preferenceTypeId", {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "preferenceTypes", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      });
      await addColumnIfMissing(queryInterface, tableName, "isEnabled", {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      });
      await addColumnIfMissing(queryInterface, tableName, "sortOrder", {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
      await addColumnIfMissing(queryInterface, tableName, "version", {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      });
      await addColumnIfMissing(queryInterface, tableName, "createdAt", {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      });
      await addColumnIfMissing(queryInterface, tableName, "updatedAt", {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      });
      await addColumnIfMissing(queryInterface, tableName, "deletedAt", {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    await ensureIndex(
      queryInterface,
      tableName,
      ["zoneId", "serviceId", "preferenceTypeId"],
      "zspo_zone_service_pref",
      true
    );
    await ensureIndex(queryInterface, tableName, ["zoneId"], "zspo_zone_idx");
    await ensureIndex(queryInterface, tableName, ["serviceId"], "zspo_service_idx");
    await ensureIndex(
      queryInterface,
      tableName,
      ["preferenceTypeId"],
      "zspo_preference_type_idx"
    );
  },

  async down(queryInterface) {
    const tableName = "zoneServicePreferenceOverrides";
    if (await tableExists(queryInterface, tableName)) {
      await queryInterface.dropTable(tableName);
    }
  },
};

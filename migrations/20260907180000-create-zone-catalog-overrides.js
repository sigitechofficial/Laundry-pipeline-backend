"use strict";

const { tableExists } = require("../utils/migrationHelpers");

function idCol(Sequelize) {
  return {
    type: Sequelize.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false,
  };
}

function timestamps(Sequelize) {
  return {
    createdAt: { type: Sequelize.DATE, allowNull: false },
    updatedAt: { type: Sequelize.DATE, allowNull: false },
    deletedAt: { type: Sequelize.DATE, allowNull: true },
  };
}

async function createOverrideTable(queryInterface, Sequelize, table, extra = {}) {
  if (await tableExists(queryInterface, table)) return;
  await queryInterface.createTable(table, {
    id: idCol(Sequelize),
    zoneId: {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: "zones", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
    },
    isEnabled: {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    sortOrder: { type: Sequelize.INTEGER, allowNull: true },
    version: {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    ...extra,
    ...timestamps(Sequelize),
  });
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await createOverrideTable(queryInterface, Sequelize, "zoneServiceOverrides", {
      serviceId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "services", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
    });
    await createOverrideTable(queryInterface, Sequelize, "zoneCategoryOverrides", {
      categoryId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "categories", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
    });
    await createOverrideTable(queryInterface, Sequelize, "zoneSubCategoryOverrides", {
      subCategoryId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "subCategories", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      price: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
    });
    await createOverrideTable(queryInterface, Sequelize, "zoneAddOnCategoryOverrides", {
      addOnCategoryId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "addOnCategories", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
    });
    await createOverrideTable(queryInterface, Sequelize, "zoneAddOnServiceOverrides", {
      addOnServiceId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "addOnServices", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      price: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
    });
    await createOverrideTable(queryInterface, Sequelize, "zoneRepairGarmentOverrides", {
      repairGarmentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "repairGarments", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
    });
    await createOverrideTable(queryInterface, Sequelize, "zoneRepairOptionOverrides", {
      repairOptionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "repairOptions", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      price: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
    });
    await createOverrideTable(
      queryInterface,
      Sequelize,
      "zoneSubCategoryAddOnOverrides",
      {
        subCategoryId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "subCategories", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        addOnCategoryId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "addOnCategories", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
      }
    );

    const uniques = [
      ["zoneServiceOverrides", ["zoneId", "serviceId"], "zso_zone_service"],
      ["zoneCategoryOverrides", ["zoneId", "categoryId"], "zco_zone_category"],
      ["zoneSubCategoryOverrides", ["zoneId", "subCategoryId"], "zsco_zone_item"],
      ["zoneAddOnCategoryOverrides", ["zoneId", "addOnCategoryId"], "zaco_zone_ac"],
      ["zoneAddOnServiceOverrides", ["zoneId", "addOnServiceId"], "zaso_zone_as"],
      ["zoneRepairGarmentOverrides", ["zoneId", "repairGarmentId"], "zrgo_zone_g"],
      ["zoneRepairOptionOverrides", ["zoneId", "repairOptionId"], "zroo_zone_o"],
      [
        "zoneSubCategoryAddOnOverrides",
        ["zoneId", "subCategoryId", "addOnCategoryId"],
        "zscao_zone_item_ac",
      ],
    ];
    for (const [table, fields, name] of uniques) {
      try {
        await queryInterface.addIndex(table, fields, {
          unique: true,
          name,
        });
      } catch (err) {
        if (!/exists|duplicate/i.test(err.message || "")) throw err;
      }
    }

    // Dual-ownership heal: every category.serviceId must have a junction row.
    try {
      const [cols] = await queryInterface.sequelize.query("SHOW COLUMNS FROM serviceCategories");
      const names = new Set((cols || []).map((c) => c.Field));
      const insertCols = ["serviceId", "categoryId"];
      const selectCols = ["c.serviceId", "c.id"];
      if (names.has("status")) {
        insertCols.push("status");
        selectCols.push("1");
      }
      if (names.has("createdAt")) {
        insertCols.push("createdAt");
        selectCols.push("NOW()");
      }
      if (names.has("updatedAt")) {
        insertCols.push("updatedAt");
        selectCols.push("NOW()");
      }
      await queryInterface.sequelize.query(`
        INSERT INTO serviceCategories (${insertCols.join(", ")})
        SELECT ${selectCols.join(", ")}
        FROM categories c
        WHERE c.serviceId IS NOT NULL
          AND c.deletedAt IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM serviceCategories sc
            WHERE sc.serviceId = c.serviceId AND sc.categoryId = c.id
              AND sc.deletedAt IS NULL
          )
      `);
    } catch (err) {
      console.warn("[zone-catalog migration] serviceCategories heal skipped:", err.message);
    }
  },

  async down(queryInterface) {
    const tables = [
      "zoneSubCategoryAddOnOverrides",
      "zoneRepairOptionOverrides",
      "zoneRepairGarmentOverrides",
      "zoneAddOnServiceOverrides",
      "zoneAddOnCategoryOverrides",
      "zoneSubCategoryOverrides",
      "zoneCategoryOverrides",
      "zoneServiceOverrides",
    ];
    for (const table of tables) {
      if (await tableExists(queryInterface, table)) {
        await queryInterface.dropTable(table);
      }
    }
  },
};

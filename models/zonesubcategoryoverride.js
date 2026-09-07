"use strict";
const { Model } = require("sequelize");

module.exports = (sequelize, DataTypes) => {
  class zoneSubCategoryOverride extends Model {
    static associate(models) {
      zoneSubCategoryOverride.belongsTo(models.zone, { foreignKey: "zoneId" });
      zoneSubCategoryOverride.belongsTo(models.subCategories, {
        foreignKey: "subCategoryId",
      });
    }
  }
  zoneSubCategoryOverride.init(
    {
      zoneId: { type: DataTypes.INTEGER, allowNull: false },
      subCategoryId: { type: DataTypes.INTEGER, allowNull: false },
      isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      price: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    {
      sequelize,
      modelName: "zoneSubCategoryOverride",
      tableName: "zoneSubCategoryOverrides",
      paranoid: true,
    }
  );
  return zoneSubCategoryOverride;
};

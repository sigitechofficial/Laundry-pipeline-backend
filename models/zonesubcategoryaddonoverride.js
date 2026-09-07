"use strict";
const { Model } = require("sequelize");

module.exports = (sequelize, DataTypes) => {
  class zoneSubCategoryAddOnOverride extends Model {
    static associate(models) {
      zoneSubCategoryAddOnOverride.belongsTo(models.zone, { foreignKey: "zoneId" });
      zoneSubCategoryAddOnOverride.belongsTo(models.subCategories, {
        foreignKey: "subCategoryId",
      });
      zoneSubCategoryAddOnOverride.belongsTo(models.addOnCategory, {
        foreignKey: "addOnCategoryId",
      });
    }
  }
  zoneSubCategoryAddOnOverride.init(
    {
      zoneId: { type: DataTypes.INTEGER, allowNull: false },
      subCategoryId: { type: DataTypes.INTEGER, allowNull: false },
      addOnCategoryId: { type: DataTypes.INTEGER, allowNull: false },
      isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    {
      sequelize,
      modelName: "zoneSubCategoryAddOnOverride",
      tableName: "zoneSubCategoryAddOnOverrides",
      paranoid: true,
    }
  );
  return zoneSubCategoryAddOnOverride;
};

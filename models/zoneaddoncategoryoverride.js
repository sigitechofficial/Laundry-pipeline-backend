"use strict";
const { Model } = require("sequelize");

module.exports = (sequelize, DataTypes) => {
  class zoneAddOnCategoryOverride extends Model {
    static associate(models) {
      zoneAddOnCategoryOverride.belongsTo(models.zone, { foreignKey: "zoneId" });
      zoneAddOnCategoryOverride.belongsTo(models.addOnCategory, {
        foreignKey: "addOnCategoryId",
      });
    }
  }
  zoneAddOnCategoryOverride.init(
    {
      zoneId: { type: DataTypes.INTEGER, allowNull: false },
      addOnCategoryId: { type: DataTypes.INTEGER, allowNull: false },
      isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    {
      sequelize,
      modelName: "zoneAddOnCategoryOverride",
      tableName: "zoneAddOnCategoryOverrides",
      paranoid: true,
    }
  );
  return zoneAddOnCategoryOverride;
};

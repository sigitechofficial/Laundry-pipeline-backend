"use strict";
const { Model } = require("sequelize");

module.exports = (sequelize, DataTypes) => {
  class zoneCategoryOverride extends Model {
    static associate(models) {
      zoneCategoryOverride.belongsTo(models.zone, { foreignKey: "zoneId" });
      zoneCategoryOverride.belongsTo(models.categories, { foreignKey: "categoryId" });
    }
  }
  zoneCategoryOverride.init(
    {
      zoneId: { type: DataTypes.INTEGER, allowNull: false },
      categoryId: { type: DataTypes.INTEGER, allowNull: false },
      isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    {
      sequelize,
      modelName: "zoneCategoryOverride",
      tableName: "zoneCategoryOverrides",
      paranoid: true,
    }
  );
  return zoneCategoryOverride;
};

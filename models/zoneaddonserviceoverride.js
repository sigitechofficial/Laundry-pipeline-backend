"use strict";
const { Model } = require("sequelize");

module.exports = (sequelize, DataTypes) => {
  class zoneAddOnServiceOverride extends Model {
    static associate(models) {
      zoneAddOnServiceOverride.belongsTo(models.zone, { foreignKey: "zoneId" });
      zoneAddOnServiceOverride.belongsTo(models.addOnServices, {
        foreignKey: "addOnServiceId",
      });
    }
  }
  zoneAddOnServiceOverride.init(
    {
      zoneId: { type: DataTypes.INTEGER, allowNull: false },
      addOnServiceId: { type: DataTypes.INTEGER, allowNull: false },
      isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      price: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    {
      sequelize,
      modelName: "zoneAddOnServiceOverride",
      tableName: "zoneAddOnServiceOverrides",
      paranoid: true,
    }
  );
  return zoneAddOnServiceOverride;
};

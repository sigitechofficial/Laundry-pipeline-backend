"use strict";
const { Model } = require("sequelize");

module.exports = (sequelize, DataTypes) => {
  class zoneRepairOptionOverride extends Model {
    static associate(models) {
      zoneRepairOptionOverride.belongsTo(models.zone, { foreignKey: "zoneId" });
      zoneRepairOptionOverride.belongsTo(models.repairOption, {
        foreignKey: "repairOptionId",
      });
    }
  }
  zoneRepairOptionOverride.init(
    {
      zoneId: { type: DataTypes.INTEGER, allowNull: false },
      repairOptionId: { type: DataTypes.INTEGER, allowNull: false },
      isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      price: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    {
      sequelize,
      modelName: "zoneRepairOptionOverride",
      tableName: "zoneRepairOptionOverrides",
      paranoid: true,
    }
  );
  return zoneRepairOptionOverride;
};

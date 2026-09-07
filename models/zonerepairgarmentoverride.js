"use strict";
const { Model } = require("sequelize");

module.exports = (sequelize, DataTypes) => {
  class zoneRepairGarmentOverride extends Model {
    static associate(models) {
      zoneRepairGarmentOverride.belongsTo(models.zone, { foreignKey: "zoneId" });
      zoneRepairGarmentOverride.belongsTo(models.repairGarment, {
        foreignKey: "repairGarmentId",
      });
    }
  }
  zoneRepairGarmentOverride.init(
    {
      zoneId: { type: DataTypes.INTEGER, allowNull: false },
      repairGarmentId: { type: DataTypes.INTEGER, allowNull: false },
      isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    {
      sequelize,
      modelName: "zoneRepairGarmentOverride",
      tableName: "zoneRepairGarmentOverrides",
      paranoid: true,
    }
  );
  return zoneRepairGarmentOverride;
};

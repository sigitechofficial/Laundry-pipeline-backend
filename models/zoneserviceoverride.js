"use strict";
const { Model } = require("sequelize");

module.exports = (sequelize, DataTypes) => {
  class zoneServiceOverride extends Model {
    static associate(models) {
      zoneServiceOverride.belongsTo(models.zone, { foreignKey: "zoneId" });
      zoneServiceOverride.belongsTo(models.service, { foreignKey: "serviceId" });
    }
  }
  zoneServiceOverride.init(
    {
      zoneId: { type: DataTypes.INTEGER, allowNull: false },
      serviceId: { type: DataTypes.INTEGER, allowNull: false },
      isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    {
      sequelize,
      modelName: "zoneServiceOverride",
      tableName: "zoneServiceOverrides",
      paranoid: true,
    }
  );
  return zoneServiceOverride;
};

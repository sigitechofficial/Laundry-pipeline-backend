"use strict";
const { Model } = require("sequelize");

module.exports = (sequelize, DataTypes) => {
  class zoneServicePreferenceOverride extends Model {
    static associate(models) {
      zoneServicePreferenceOverride.belongsTo(models.zone, {
        foreignKey: "zoneId",
      });
      zoneServicePreferenceOverride.belongsTo(models.service, {
        foreignKey: "serviceId",
      });
      zoneServicePreferenceOverride.belongsTo(models.preferenceTypes, {
        foreignKey: "preferenceTypeId",
      });
    }
  }

  zoneServicePreferenceOverride.init(
    {
      zoneId: { type: DataTypes.INTEGER, allowNull: false },
      serviceId: { type: DataTypes.INTEGER, allowNull: false },
      preferenceTypeId: { type: DataTypes.INTEGER, allowNull: false },
      isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    {
      sequelize,
      modelName: "zoneServicePreferenceOverride",
      tableName: "zoneServicePreferenceOverrides",
      paranoid: true,
    }
  );

  return zoneServicePreferenceOverride;
};

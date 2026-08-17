"use strict";
const { Model } = require("sequelize");

module.exports = (sequelize, DataTypes) => {
  class platformRuntimeSetting extends Model {
    static associate() {}
  }

  platformRuntimeSetting.init(
    {
      settingKey: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
      },
      settingValue: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      valueType: {
        type: DataTypes.ENUM("boolean", "integer"),
        allowNull: false,
        defaultValue: "boolean",
      },
      label: {
        type: DataTypes.STRING(160),
        allowNull: false,
      },
      description: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      settingGroup: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: "ops",
      },
      envKey: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      updatedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: "platformRuntimeSetting",
      tableName: "platformRuntimeSettings",
    }
  );

  return platformRuntimeSetting;
};

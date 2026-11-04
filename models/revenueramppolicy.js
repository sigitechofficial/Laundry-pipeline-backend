'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class revenueRampPolicy extends Model {
    static associate() {}
  }

  revenueRampPolicy.init(
    {
      enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      applyToAllZones: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      zoneIds: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: '[]',
      },
    },
    {
      sequelize,
      modelName: 'revenueRampPolicy',
      tableName: 'revenueRampPolicies',
    }
  );

  return revenueRampPolicy;
};

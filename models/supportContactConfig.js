'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class supportContactConfig extends Model {
    static associate() {}
  }

  supportContactConfig.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      supportEmail: {
        type: DataTypes.STRING(255),
        allowNull: true
      },
      supportPhone: {
        type: DataTypes.STRING(50),
        allowNull: true
      },
      helpUrl: {
        type: DataTypes.STRING(500),
        allowNull: true
      },
      supportHours: {
        type: DataTypes.TEXT,
        allowNull: true
      }
    },
    {
      sequelize,
      modelName: 'supportContactConfig',
      tableName: 'support_contact_configs',
      timestamps: true
    }
  );

  return supportContactConfig;
};

'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class attemptFailReason extends Model {
    static associate(models) {
      attemptFailReason.hasMany(models.bookingAttempt, {
        foreignKey: 'failureReasonId',
        as: 'attempts',
      });
    }
  }

  attemptFailReason.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      code: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
      },
      label: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      description: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      scope: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'both',
      },
      chargesFee: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      requiresNote: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      isOther: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      status: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      sequelize,
      modelName: 'attemptFailReason',
      tableName: 'attempt_fail_reasons',
    }
  );

  return attemptFailReason;
};

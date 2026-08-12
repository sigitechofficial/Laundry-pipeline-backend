'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class reviewReasonCode extends Model {
    static associate(models) {
      reviewReasonCode.hasMany(models.shopReviewReason, {
        foreignKey: 'reasonCodeId',
        as: 'reviewSelections',
      });
    }
  }

  reviewReasonCode.init(
    {
      code: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
      },
      label: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      sentiment: {
        type: DataTypes.ENUM('positive', 'negative'),
        allowNull: false,
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
      isOther: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      sequelize,
      modelName: 'reviewReasonCode',
      tableName: 'reviewReasonCodes',
    }
  );

  return reviewReasonCode;
};

'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class shopReviewReason extends Model {
    static associate(models) {
      shopReviewReason.belongsTo(models.shopReview, {
        foreignKey: 'shopReviewId',
        as: 'review',
      });
      shopReviewReason.belongsTo(models.reviewReasonCode, {
        foreignKey: 'reasonCodeId',
        as: 'reasonCode',
      });
    }
  }

  shopReviewReason.init(
    {
      shopReviewId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      reasonCodeId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      otherText: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'shopReviewReason',
      tableName: 'shopReviewReasons',
    }
  );

  return shopReviewReason;
};

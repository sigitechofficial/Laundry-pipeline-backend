'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class shopReviewStat extends Model {
    static associate(models) {
      shopReviewStat.belongsTo(models.bussinessInformation, {
        foreignKey: 'businessInfoId',
        as: 'shop',
      });
    }
  }

  shopReviewStat.init(
    {
      businessInfoId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true,
      },
      avgRating: {
        type: DataTypes.DECIMAL(3, 2),
        allowNull: false,
        defaultValue: 0,
      },
      ratingCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      publishedCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      rating1: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      rating2: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      rating3: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      rating4: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      rating5: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      topPositiveReasonCode: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      topNegativeReasonCode: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'shopReviewStat',
      tableName: 'shopReviewStats',
    }
  );

  return shopReviewStat;
};

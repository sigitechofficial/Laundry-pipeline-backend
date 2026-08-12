'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class shopReview extends Model {
    static associate(models) {
      shopReview.belongsTo(models.booking, {
        foreignKey: 'bookingId',
        as: 'booking',
      });
      shopReview.belongsTo(models.users, {
        foreignKey: 'customerId',
        as: 'customer',
      });
      shopReview.belongsTo(models.bussinessInformation, {
        foreignKey: 'businessInfoId',
        as: 'shop',
      });
      shopReview.belongsTo(models.users, {
        foreignKey: 'hiddenByAdminId',
        as: 'hiddenByAdmin',
      });
      shopReview.hasMany(models.shopReviewReason, {
        foreignKey: 'shopReviewId',
        as: 'reasons',
      });
    }
  }

  shopReview.init(
    {
      bookingId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true,
      },
      customerId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      businessInfoId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      laundryShopId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      rating: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      comment: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      visibility: {
        type: DataTypes.ENUM('published', 'hidden'),
        allowNull: false,
        defaultValue: 'published',
      },
      hiddenReason: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      hiddenByAdminId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      hiddenAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      submittedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      sequelize,
      modelName: 'shopReview',
      tableName: 'shopReviews',
      paranoid: true,
    }
  );

  return shopReview;
};

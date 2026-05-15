'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class banner extends Model {
    static associate() {}
  }

  banner.init(
    {
      title: {
        type: DataTypes.STRING(200),
        allowNull: false
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      bannerImage: {
        type: DataTypes.STRING(500),
        allowNull: true
      },
      offerType: {
        type: DataTypes.ENUM('percentage', 'flat', 'free_delivery'),
        allowNull: false
      },
      discountValue: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true
      },
      maxDiscountCap: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true
      },
      targetType: {
        type: DataTypes.ENUM('global', 'service', 'category', 'sub_category'),
        allowNull: false
      },
      targetId: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      zoneIds: {
        type: DataTypes.JSON,
        allowNull: true
      },
      startDate: {
        type: DataTypes.DATEONLY,
        allowNull: true
      },
      endDate: {
        type: DataTypes.DATEONLY,
        allowNull: true
      },
      displayOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1
      },
      showOnHome: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
      }
    },
    {
      sequelize,
      modelName: 'banner',
      tableName: 'banners'
    }
  );

  return banner;
};

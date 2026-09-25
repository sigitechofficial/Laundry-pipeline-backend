'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class coupon extends Model {
    static associate(models) {
      coupon.hasMany(models.couponRedemption, {
        foreignKey: 'couponId',
        as: 'redemptions'
      });
    }
  }

  coupon.init({
    code: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true
    },
    description: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    discountType: {
      type: DataTypes.ENUM('percentage', 'flat'),
      allowNull: false,
      defaultValue: 'flat'
    },
    discountValue: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false
    },
    minOrderAmount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null
    },
    maxDiscountCap: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null
    },
    usageLimit: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null
    },
    usedCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    perUserLimit: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    },
    startDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      defaultValue: null
    },
    expiryDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      defaultValue: null
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    // null / [] = all zones; otherwise JSON array of zone ids (same as banners).
    zoneIds: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null
    }
  }, {
    sequelize,
    modelName: 'coupon',
    tableName: 'coupons'
  });

  return coupon;
};

'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class couponRedemption extends Model {
    static associate(models) {
      couponRedemption.belongsTo(models.coupon, {
        foreignKey: 'couponId',
        as: 'coupon'
      });
      couponRedemption.belongsTo(models.users, {
        foreignKey: 'userId',
        as: 'user'
      });
      couponRedemption.belongsTo(models.booking, {
        foreignKey: 'bookingId',
        as: 'booking'
      });
    }
  }

  couponRedemption.init({
    couponId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'coupons',
        key: 'id'
      }
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    bookingId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'bookings',
        key: 'id'
      }
    },
    discountAmt: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'couponRedemption',
    tableName: 'couponRedemptions'
  });

  return couponRedemption;
};

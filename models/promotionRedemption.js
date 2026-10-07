'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class promotionRedemption extends Model {
    static associate(models) {
      promotionRedemption.belongsTo(models.promotion, { foreignKey: 'promotionId', as: 'promotion' });
      promotionRedemption.belongsTo(models.couponCode, { foreignKey: 'couponCodeId', as: 'coupon' });
      promotionRedemption.belongsTo(models.booking, { foreignKey: 'bookingId', as: 'booking' });
    }
  }

  promotionRedemption.init(
    {
      promotionId: { type: DataTypes.INTEGER, allowNull: false },
      promotionVersionId: { type: DataTypes.INTEGER, allowNull: true },
      couponCodeId: { type: DataTypes.INTEGER, allowNull: true },
      couponCode: { type: DataTypes.STRING(50), allowNull: true },
      customerId: { type: DataTypes.INTEGER, allowNull: false },
      bookingId: { type: DataTypes.INTEGER, allowNull: true },

      status: {
        type: DataTypes.ENUM('RESERVED', 'COMMITTED', 'RELEASED', 'REVERSED'),
        allowNull: false,
        defaultValue: 'RESERVED',
      },

      discountAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'GBP' },
      zoneId: { type: DataTypes.INTEGER, allowNull: true },

      idempotencyKey: { type: DataTypes.STRING(200), allowNull: true, unique: true },

      reservedAt: { type: DataTypes.DATE, allowNull: true },
      reservationExpiresAt: { type: DataTypes.DATE, allowNull: true },
      committedAt: { type: DataTypes.DATE, allowNull: true },
      releasedAt: { type: DataTypes.DATE, allowNull: true },
      reversedAt: { type: DataTypes.DATE, allowNull: true },

      reason: { type: DataTypes.STRING(500), allowNull: true },
    },
    {
      sequelize,
      modelName: 'promotionRedemption',
      tableName: 'promotion_redemptions',
    }
  );

  return promotionRedemption;
};

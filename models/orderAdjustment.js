'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class orderAdjustment extends Model {
    static associate(models) {
      orderAdjustment.belongsTo(models.booking, { foreignKey: 'bookingId', as: 'booking' });
    }
  }

  orderAdjustment.init(
    {
      bookingId: { type: DataTypes.INTEGER, allowNull: false },

      adjustmentClass: {
        type: DataTypes.ENUM(
          'BASE_PRICE', 'CONTRACT_PRICE', 'ITEM_PROMOTION', 'BASKET_PROMOTION',
          'DELIVERY_PROMOTION', 'COUPON_DISCOUNT', 'MANUAL_DISCOUNT', 'TAX',
          'DELIVERY_FEE', 'SERVICE_FEE', 'WALLET_CREDIT', 'GIFT_CARD',
          'REFERRAL_CREDIT', 'LOYALTY_BENEFIT', 'RESCHEDULE_FEE', 'NO_SHOW_FEE',
          'CANCELLATION_FEE', 'REFUND'
        ),
        allowNull: false,
      },

      promotionId: { type: DataTypes.INTEGER, allowNull: true },
      promotionVersionId: { type: DataTypes.INTEGER, allowNull: true },
      couponCodeId: { type: DataTypes.INTEGER, allowNull: true },
      couponCode: { type: DataTypes.STRING(50), allowNull: true },

      lineType: {
        type: DataTypes.ENUM('subCategory', 'addon', 'delivery', 'basket'),
        allowNull: false,
        defaultValue: 'basket',
      },
      lineItemId: { type: DataTypes.INTEGER, allowNull: true },
      lineDescription: { type: DataTypes.STRING(200), allowNull: true },

      amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'GBP' },

      label: { type: DataTypes.STRING(200), allowNull: true },
      description: { type: DataTypes.STRING(500), allowNull: true },

      appliedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      appliedBy: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'system' },
      reason: { type: DataTypes.STRING(500), allowNull: true },

      reversedAt: { type: DataTypes.DATE, allowNull: true },
      reversedBy: { type: DataTypes.STRING(50), allowNull: true },
      reversalReason: { type: DataTypes.STRING(500), allowNull: true },
      originalAdjustmentId: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      sequelize,
      modelName: 'orderAdjustment',
      tableName: 'order_adjustments',
      updatedAt: false,
    }
  );

  return orderAdjustment;
};

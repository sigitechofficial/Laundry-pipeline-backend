'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class promotion extends Model {
    static associate(models) {
      promotion.belongsTo(models.campaign, { foreignKey: 'campaignId', as: 'campaign' });
      promotion.hasMany(models.promotionVersion, { foreignKey: 'promotionId', as: 'versions' });
      promotion.hasMany(models.promotionCondition, { foreignKey: 'promotionId', as: 'conditions' });
      promotion.hasMany(models.promotionZoneOverride, { foreignKey: 'promotionId', as: 'zoneOverrides' });
      promotion.hasMany(models.couponCode, { foreignKey: 'promotionId', as: 'couponCodes' });
      promotion.hasMany(models.promotionRedemption, { foreignKey: 'promotionId', as: 'redemptions' });
    }
  }

  promotion.init(
    {
      campaignId: { type: DataTypes.INTEGER, allowNull: true },
      name: { type: DataTypes.STRING(200), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      internalNotes: { type: DataTypes.TEXT, allowNull: true },

      benefitType: {
        type: DataTypes.ENUM(
          'percentage_discount',
          'fixed_amount_discount',
          'fixed_price',
          'free_delivery',
          'delivery_discount',
          'item_discount',
          'category_discount',
          'service_discount',
          'basket_discount',
          'cashback',
          'buy_x_get_y',
          'bundle',
          'first_order_discount',
          'first_x_orders_discount'
        ),
        allowNull: false,
      },

      discountValue: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      discountMode: { type: DataTypes.ENUM('percent', 'amount'), allowNull: true },
      benefitConfig: { type: DataTypes.JSON, allowNull: true },
      maxDiscountCap: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'GBP' },

      targetType: {
        type: DataTypes.ENUM('all', 'service', 'category', 'subCategory', 'addon', 'delivery', 'basket'),
        allowNull: false,
        defaultValue: 'basket',
      },
      targetIds: { type: DataTypes.JSON, allowNull: true },

      zoneScopeMode: {
        type: DataTypes.ENUM('all', 'selected', 'excluded'),
        allowNull: false,
        defaultValue: 'all',
      },
      zoneIds: { type: DataTypes.JSON, allowNull: true },

      startDate: { type: DataTypes.DATE, allowNull: true },
      endDate: { type: DataTypes.DATE, allowNull: true },
      recurringDays: { type: DataTypes.JSON, allowNull: true },
      recurringStartTime: { type: DataTypes.TIME, allowNull: true },
      recurringEndTime: { type: DataTypes.TIME, allowNull: true },

      activationType: {
        type: DataTypes.ENUM('automatic', 'coupon_required'),
        allowNull: false,
        defaultValue: 'automatic',
      },

      visibility: {
        type: DataTypes.ENUM('public', 'private_code', 'targeted', 'hidden'),
        allowNull: false,
        defaultValue: 'hidden',
      },

      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 50 },
      stackable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      stackGroup: { type: DataTypes.STRING(50), allowNull: true },

      globalUsageLimit: { type: DataTypes.INTEGER, allowNull: true },
      perCustomerLimit: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 1 },
      perDayLimit: { type: DataTypes.INTEGER, allowNull: true },
      perWeekLimit: { type: DataTypes.INTEGER, allowNull: true },

      globalUsedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      globalReservedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

      minSubtotal: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      maxSubtotal: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      minQuantity: { type: DataTypes.INTEGER, allowNull: true },

      repricingPolicy: {
        type: DataTypes.ENUM('recalculate', 'revalidate', 'lock'),
        allowNull: false,
        defaultValue: 'recalculate',
      },

      status: {
        type: DataTypes.ENUM('draft', 'pending_approval', 'approved', 'scheduled', 'active', 'paused', 'expired', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },

      currentVersionId: { type: DataTypes.INTEGER, allowNull: true },
      tags: { type: DataTypes.JSON, allowNull: true },
      createdBy: { type: DataTypes.INTEGER, allowNull: true },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      sequelize,
      modelName: 'promotion',
      tableName: 'promotions',
    }
  );

  return promotion;
};

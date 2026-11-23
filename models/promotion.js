'use strict';
const { Model } = require('sequelize');
const { jsonColumn } = require('../utils/jsonColumn');
const { businessDay, businessClock } = require('../services/promotions/promotionTime');

/**
 * A stored start / end read in the promotion's own zone. Without a zone (an older promotion
 * whose zones span several) there is no single day to show, so the answer is null; the
 * stored instant itself is still returned as startDate / endDate.
 */
function inPromotionZone(row, read, key) {
  const value = row.getDataValue(key);
  const timeZone = row.getDataValue('timeZone');
  return value == null || !timeZone ? null : read(value, timeZone);
}

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
      benefitConfig: jsonColumn(DataTypes, 'benefitConfig', { allowNull: true }),
      maxDiscountCap: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      // The admin's choice, or the currency its zones share (defaultPromotionCurrency).
      currency: { type: DataTypes.STRING(3), allowNull: false, validate: { is: /^[A-Z]{3}$/ } },

      targetType: {
        type: DataTypes.ENUM('all', 'service', 'category', 'subCategory', 'addon', 'delivery', 'basket'),
        allowNull: false,
        defaultValue: 'basket',
      },
      targetIds: jsonColumn(DataTypes, 'targetIds', { allowNull: true }),

      zoneScopeMode: {
        type: DataTypes.ENUM('all', 'selected', 'excluded'),
        allowNull: false,
        defaultValue: 'all',
      },
      zoneIds: jsonColumn(DataTypes, 'zoneIds', { allowNull: true }),

      startDate: { type: DataTypes.DATE, allowNull: true },
      endDate: { type: DataTypes.DATE, allowNull: true },
      // The IANA zone its start / end days are in: the one its zones share (their countries'),
      // set on save. Null only for an older promotion whose zones span several time zones.
      timeZone: { type: DataTypes.STRING(64), allowNull: true },
      // The calendar days the promotion runs from / to in its time zone — what the admin picked.
      startDay: { type: DataTypes.VIRTUAL, get() { return inPromotionZone(this, businessDay, 'startDate'); } },
      endDay: { type: DataTypes.VIRTUAL, get() { return inPromotionZone(this, businessDay, 'endDate'); } },
      // The times (24-hour "HH:mm") it starts / ends there: 00:00 and 23:59 for whole days.
      startTime: { type: DataTypes.VIRTUAL, get() { return inPromotionZone(this, businessClock, 'startDate'); } },
      endTime: { type: DataTypes.VIRTUAL, get() { return inPromotionZone(this, businessClock, 'endDate'); } },
      recurringDays: jsonColumn(DataTypes, 'recurringDays', { allowNull: true }),
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
      tags: jsonColumn(DataTypes, 'tags', { allowNull: true }),
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

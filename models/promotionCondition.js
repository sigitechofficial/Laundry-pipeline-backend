'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class promotionCondition extends Model {
    static associate(models) {
      promotionCondition.belongsTo(models.promotion, { foreignKey: 'promotionId', as: 'promotion' });
    }
  }

  promotionCondition.init(
    {
      promotionId: { type: DataTypes.INTEGER, allowNull: false },

      conditionType: {
        type: DataTypes.ENUM(
          'ZONE', 'CUSTOMER_TYPE', 'CUSTOMER_SEGMENT', 'FIRST_ORDER',
          'ORDER_COUNT', 'MINIMUM_SUBTOTAL', 'MAXIMUM_SUBTOTAL',
          'MINIMUM_QUANTITY', 'MAXIMUM_QUANTITY', 'SERVICE', 'CATEGORY',
          'PRODUCT', 'ADDON', 'COLLECTION_DAY', 'DELIVERY_DAY',
          'BOOKING_TIME', 'TURNAROUND_TYPE', 'PAYMENT_METHOD', 'SCHEDULE', 'COUPON'
        ),
        allowNull: false,
      },

      operator: {
        type: DataTypes.ENUM('equals', 'not_equals', 'in', 'not_in', 'gte', 'lte', 'between', 'any'),
        allowNull: false,
        defaultValue: 'equals',
      },

      value: { type: DataTypes.JSON, allowNull: false },

      logicGroup: {
        type: DataTypes.ENUM('ALL', 'ANY'),
        allowNull: false,
        defaultValue: 'ALL',
      },

      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    {
      sequelize,
      modelName: 'promotionCondition',
      tableName: 'promotion_conditions',
      updatedAt: false,
    }
  );

  return promotionCondition;
};

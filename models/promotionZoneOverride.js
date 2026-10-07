'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class promotionZoneOverride extends Model {
    static associate(models) {
      promotionZoneOverride.belongsTo(models.promotion, { foreignKey: 'promotionId', as: 'promotion' });
    }
  }

  promotionZoneOverride.init(
    {
      promotionId: { type: DataTypes.INTEGER, allowNull: false },
      zoneId: { type: DataTypes.INTEGER, allowNull: false },
      discountValue: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      maxDiscountCap: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      minSubtotal: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      currency: { type: DataTypes.STRING(3), allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      sequelize,
      modelName: 'promotionZoneOverride',
      tableName: 'promotion_zone_overrides',
    }
  );

  return promotionZoneOverride;
};

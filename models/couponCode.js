'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class couponCode extends Model {
    static associate(models) {
      couponCode.belongsTo(models.promotion, { foreignKey: 'promotionId', as: 'promotion' });
      couponCode.hasMany(models.promotionRedemption, { foreignKey: 'couponCodeId', as: 'redemptions' });
    }
  }

  couponCode.init(
    {
      promotionId: { type: DataTypes.INTEGER, allowNull: false },
      // Unique among codes not yet released (see liveCode in migration 20261121100000).
      code: { type: DataTypes.STRING(50), allowNull: false },
      // Set when its promotion is archived: the code may then be used by a new promotion.
      releasedAt: { type: DataTypes.DATE, allowNull: true },

      codeType: {
        type: DataTypes.ENUM('shared', 'unique', 'customer_bound', 'partner', 'bulk'),
        allowNull: false,
        defaultValue: 'shared',
      },

      customerId: { type: DataTypes.INTEGER, allowNull: true },
      partnerRef: { type: DataTypes.STRING(100), allowNull: true },

      usageLimit: { type: DataTypes.INTEGER, allowNull: true },
      perCustomerLimit: { type: DataTypes.INTEGER, allowNull: true },
      usedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

      activationDate: { type: DataTypes.DATE, allowNull: true },
      expiryDate: { type: DataTypes.DATE, allowNull: true },

      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdBy: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      sequelize,
      modelName: 'couponCode',
      tableName: 'coupon_codes',
    }
  );

  return couponCode;
};

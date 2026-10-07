'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class promotionAuditLog extends Model {
    static associate() {}
  }

  promotionAuditLog.init(
    {
      entityType: {
        type: DataTypes.ENUM('campaign', 'promotion', 'coupon_code', 'redemption', 'adjustment'),
        allowNull: false,
      },
      entityId: { type: DataTypes.INTEGER, allowNull: false },

      action: { type: DataTypes.STRING(50), allowNull: false },
      actorId: { type: DataTypes.INTEGER, allowNull: true },
      actorType: { type: DataTypes.STRING(20), allowNull: true },

      oldValue: { type: DataTypes.JSON, allowNull: true },
      newValue: { type: DataTypes.JSON, allowNull: true },

      reason: { type: DataTypes.STRING(500), allowNull: true },
      correlationId: { type: DataTypes.STRING(100), allowNull: true },
    },
    {
      sequelize,
      modelName: 'promotionAuditLog',
      tableName: 'promotion_audit_logs',
      updatedAt: false,
    }
  );

  return promotionAuditLog;
};

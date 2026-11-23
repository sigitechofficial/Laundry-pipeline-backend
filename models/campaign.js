'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class campaign extends Model {
    static associate(models) {
      campaign.hasMany(models.promotion, { foreignKey: 'campaignId', as: 'promotions' });
      campaign.hasMany(models.promotionAuditLog, {
        foreignKey: 'entityId',
        constraints: false,
        scope: { entityType: 'campaign' },
        as: 'auditLogs',
      });
    }
  }

  campaign.init(
    {
      name: { type: DataTypes.STRING(200), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      objective: { type: DataTypes.STRING(255), allowNull: true },
      channel: { type: DataTypes.STRING(100), allowNull: true },

      budgetMinor: { type: DataTypes.INTEGER, allowNull: true },
      usedBudgetMinor: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // Currency of the budget, chosen by the admin (a campaign has no zone). Required when
      // there is a budget; null without one. Never defaulted.
      currency: { type: DataTypes.STRING(3), allowNull: true, validate: { is: /^[A-Z]{3}$/ } },
      // Set when this budget belongs to one offer (its own budget); null = shared budget.
      ownerPromotionId: { type: DataTypes.INTEGER, allowNull: true },

      startDate: { type: DataTypes.DATEONLY, allowNull: true },
      endDate: { type: DataTypes.DATEONLY, allowNull: true },

      status: {
        type: DataTypes.ENUM('draft', 'active', 'paused', 'completed', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },

      createdBy: { type: DataTypes.INTEGER, allowNull: true },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      sequelize,
      modelName: 'campaign',
      tableName: 'campaigns',
    }
  );

  return campaign;
};

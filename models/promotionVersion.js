'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class promotionVersion extends Model {
    static associate(models) {
      promotionVersion.belongsTo(models.promotion, { foreignKey: 'promotionId', as: 'promotion' });
    }
  }

  promotionVersion.init(
    {
      promotionId: { type: DataTypes.INTEGER, allowNull: false },
      versionNumber: { type: DataTypes.INTEGER, allowNull: false },
      configSnapshot: { type: DataTypes.JSON, allowNull: false },
      publishedAt: { type: DataTypes.DATE, allowNull: true },
      publishedBy: { type: DataTypes.INTEGER, allowNull: true },
      reason: { type: DataTypes.STRING(500), allowNull: true },
    },
    {
      sequelize,
      modelName: 'promotionVersion',
      tableName: 'promotion_versions',
      updatedAt: false,
    }
  );

  return promotionVersion;
};

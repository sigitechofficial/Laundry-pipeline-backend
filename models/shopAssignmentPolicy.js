'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class shopAssignmentPolicy extends Model {
    static associate(models) {
      shopAssignmentPolicy.belongsTo(models.users, {
        foreignKey: 'shopUserId',
        as: 'shopOwner',
      });
    }
  }

  shopAssignmentPolicy.init(
    {
      shopUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true,
      },
      preferredEligible: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      marketplaceHold: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      reason: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
      },
      updatedByUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'shopAssignmentPolicy',
      tableName: 'shopAssignmentPolicies',
    }
  );

  return shopAssignmentPolicy;
};

'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class cancellationPolicyConfig extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
    }
  }
  cancellationPolicyConfig.init({
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    policyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'policies',
        key: 'id'
      }
    },
    // Policy Status
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    
    // Pre-Pickup / Driver en-route Section
    prePickupAbsoluteCurrency: {
      type: DataTypes.STRING(10),
      allowNull: true,
      defaultValue: 'USD',
      comment: 'Currency for absolute charges'
    },
    prePickupAbsoluteAmount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Absolute amount to charge for pre-pickup cancellation'
    },
    prePickupPercentage: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Percentage to charge for pre-pickup cancellation'
    },
    prePickupFreeChargeWindowMinutes: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 120,
      comment: 'Free cancellation window in minutes before pickup'
    },
    prePickupFirstCancellationLeniency: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'On first cancellation order, no charges'
    },
    
    // Unprocessed Section
    unprocessedAbsoluteCurrency: {
      type: DataTypes.STRING(10),
      allowNull: true,
      defaultValue: 'USD',
      comment: 'Currency for unprocessed charges'
    },
    unprocessedAbsoluteAmount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Absolute amount to charge for unprocessed cancellation'
    },
    unprocessedPercentage: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment:
        'Legacy duplicate of unprocessedOrderValuePercentage; cancel fee prefers unprocessedOrderValuePercentage and falls back to this',
    },
    unprocessedAfterPickupMinutes: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 30,
      comment: 'Time window in minutes after pickup to consider as unprocessed'
    },
    unprocessedOrderValuePercentage: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      defaultValue: 15.00,
      comment:
        'Canonical % of prepaid (upfront + service fee + tip) charged for unprocessed cancellation',
    },
    allowCancelUnprocessed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'Allow cancellation for unprocessed orders'
    },
    
    // Customer Leniency Section
    courtesyWindowDays: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 30,
      comment: 'Courtesy window in days for customer leniency'
    },
    courtesyCapAmount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 15.00,
      comment: 'Courtesy cap amount'
    },
    courtesyCount: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 1,
      comment: 'Number of courtesy cancellations allowed'
    },
    customerLeniencyEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'Enable customer leniency feature'
    }
  }, {
    sequelize,
    modelName: 'cancellationPolicyConfig',
    tableName: 'cancellation_policy_configs',
    timestamps: true,
    paranoid: true
  });
  return cancellationPolicyConfig;
};


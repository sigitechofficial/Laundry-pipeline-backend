'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class reschedulePolicyConfig extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      reschedulePolicyConfig.belongsTo(models.policy, {
        foreignKey: 'policyId'
      });
    }
  }
  reschedulePolicyConfig.init({
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
      defaultValue: true,
      comment: 'Reschedule policy toggle'
    },
    
    // At Pickup Section
    atPickupAbsoluteCurrency: {
      type: DataTypes.STRING(10),
      allowNull: true,
      defaultValue: 'USD',
      comment: 'Currency for absolute charges at pickup'
    },
    atPickupAbsoluteAmount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Absolute amount to charge for reschedule at pickup'
    },
    atPickupPercentage: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Percentage to charge for reschedule at pickup'
    },
    atPickupCourtesyCount: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 1,
      comment: 'Number of courtesy reschedules allowed at pickup'
    },
    atPickupCourtesyCountEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'Enable courtesy count at pickup'
    },
    
    // At Delivery Section
    atDeliveryAbsoluteCurrency: {
      type: DataTypes.STRING(10),
      allowNull: true,
      defaultValue: 'USD',
      comment: 'Currency for absolute charges at delivery'
    },
    atDeliveryAbsoluteAmount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Absolute amount to charge for reschedule at delivery'
    },
    atDeliveryPercentage: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Percentage to charge for reschedule at delivery'
    },
    atDeliveryCourtesyCount: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 1,
      comment: 'Number of courtesy reschedules allowed at delivery'
    },
    atDeliveryCourtesyCountEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'Enable courtesy count at delivery'
    },
    
    // Customer Leniency Section
    courtesyWindowDays: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 30,
      comment: 'Courtesy window in days (or minutes if less than 1 day)'
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
      comment: 'Number of courtesy reschedules allowed'
    },
    customerLeniencyEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'Enable customer leniency feature'
    }
  }, {
    sequelize,
    modelName: 'reschedulePolicyConfig',
    tableName: 'reschedule_policy_configs',
    timestamps: true,
    paranoid: true
  });
  return reschedulePolicyConfig;
};


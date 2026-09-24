'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class noShowPolicyConfig extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // Relation with Policy Model
      noShowPolicyConfig.belongsTo(models.policy)
      models.policy.hasOne(noShowPolicyConfig)
    }
  }
  noShowPolicyConfig.init({
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
    // Basic Settings
    enableForPickup: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    enableForDelivery: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    useUnifiedFee: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    
    // Fee Configuration
    feeType: {
      type: DataTypes.ENUM('absolute', 'percentage', 'both'),
      allowNull: false,
      defaultValue: 'absolute'
    },
    currency: {
      type: DataTypes.STRING(10),
      allowNull: true,
      defaultValue: 'USD'
    },
    pickupNoShowFee: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 15.00
    },
    deliveryNoShowFee: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 20.00
    },
    storageFeePerDay: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 1.00
    },
    percentageFee: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Percentage fee (e.g., 5.00 for 5%)'
    },
    
    // Eligibility Configuration
    graceMinutesOnSite: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 15,
      comment: 'Minutes to wait before no-show applies'
    },
    driverLateSLA: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 30,
      comment: 'Driver late SLA in minutes - auto-waive if exceeded'
    },
    waiveFeeIfDriverLate: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'When ON, waive the customer no-show/reschedule penalty if the driver arrives after the scheduled window (beyond driverLateSLA grace)'
    },
    arrivalRadiusMeters: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 100,
      comment: 'Geofence radius in meters for Arrived / no-show / unattended'
    },
    callsMinutes: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 5,
      comment: 'Minutes to wait before no-show applies for calls'
    },
    smsMinutes: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 5,
      comment: 'Minutes to wait before no-show applies for SMS'
    },
    
    // Unattended Options
    pickupBagAtDoor: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    deliveryLeaveAtDoor: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    concierge: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    locker: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    requirePhoto: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    
    // Waivers & Caps
    waiverType: {
      type: DataTypes.ENUM('absolute', 'percentage', 'both'),
      allowNull: true,
      defaultValue: 'absolute'
    },
    absoluteWaiverAmount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Absolute amount for auto-waive'
    },
    percentageWaiverAmount: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Percentage of order value for auto-waive'
    },
    autoForgiveFirstNoShow: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    autoForgiveCount: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 1,
      comment: 'Number of no-shows to auto-forgive'
    },
    autoForgivePeriod: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 30,
      comment: 'Period in days for auto-forgive'
    },
    requirePaymentAfterCap: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    perCustomerCap: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 3,
      comment: 'Maximum charges per customer'
    },
    capWindowDays: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 90,
      comment: 'Window in days for cap calculation'
    }
  }, {
    sequelize,
    modelName: 'noShowPolicyConfig',
    tableName: 'no_show_policy_configs',
    timestamps: true,
    paranoid: true
  });
  return noShowPolicyConfig;
};
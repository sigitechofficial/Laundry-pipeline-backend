'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class policy extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // Relation with NoShowPolicyConfig Model
      policy.hasOne(models.noShowPolicyConfig)
      models.noShowPolicyConfig.belongsTo(policy)
      
      // Relation with CancellationPolicyConfig Model
      policy.hasOne(models.cancellationPolicyConfig, {
        foreignKey: 'policyId',
        as: 'cancellationConfig'
      })
      models.cancellationPolicyConfig.belongsTo(policy)

      // Relation with ReschedulePolicyConfig Model
      policy.hasOne(models.reschedulePolicyConfig, {
        foreignKey: 'policyId',
        as: 'rescheduleConfig'
      })
      models.reschedulePolicyConfig.belongsTo(policy)


     //Realtion with the Booking Table as Cancellation Policy 
      policy.hasMany(models.booking,{foreignKey:'cancellationPolicyId',as:'cancellationPolicyBookings'})
     models.booking.belongsTo(policy, {
      foreignKey: 'cancellationPolicyId',
      as: 'cancellationPolicyBookings'
    })

         //Realtion with the Booking Table as No Show Policy 
      policy.hasMany(models.booking,{foreignKey:'noShowPolicyId',as:'noShowPolicyBookings'})
     models.booking.belongsTo(policy, {
      foreignKey: 'noShowPolicyId',
      as: 'noShowPolicyBookings'
    })




    }


  }
  policy.init({
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    type: {
      type: DataTypes.ENUM('no_show', 'cancellation', 'late_pickup', 'late_delivery', 'reschedule'),
      allowNull: false,
      defaultValue: 'no_show'
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    isDefault: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    updatedBy: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'policy',
    tableName: 'policies',
    timestamps: true,
    paranoid: true
  });
  return policy;
};
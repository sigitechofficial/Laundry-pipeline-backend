'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class recurringPlan extends Model {
    static associate(models) {
      recurringPlan.belongsTo(models.users, {
        foreignKey: 'customerId',
        as: 'customer',
      });
      recurringPlan.belongsTo(models.booking, {
        foreignKey: 'sourceBookingId',
        as: 'sourceBooking',
      });
      recurringPlan.hasMany(models.booking, {
        foreignKey: 'recurringPlanId',
        as: 'bookings',
      });
    }
  }

  recurringPlan.init(
    {
      customerId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      sourceBookingId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      frequency: {
        type: DataTypes.ENUM(
          'Just Once',
          'Weekly',
          'Every two weeks',
          'Every four weeks'
        ),
        allowNull: false,
        defaultValue: 'Just Once',
      },
      status: {
        type: DataTypes.ENUM('active', 'paused', 'cancelled'),
        allowNull: false,
        defaultValue: 'active',
      },
      nextRunAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      lastGeneratedFromBookingId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      lastGeneratedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      failureCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      maxFailures: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 3,
      },
      notes: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'recurringPlan',
      tableName: 'recurringPlans',
    }
  );

  return recurringPlan;
};

'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class agentComplianceEvent extends Model {
    static associate(models) {
      agentComplianceEvent.belongsTo(models.booking, {
        foreignKey: 'bookingId',
        as: 'booking',
      });
      agentComplianceEvent.belongsTo(models.users, {
        foreignKey: 'actorUserId',
        as: 'actor',
      });
      agentComplianceEvent.belongsTo(models.users, {
        foreignKey: 'shopId',
        as: 'shop',
      });
    }
  }

  agentComplianceEvent.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      bookingId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      actorUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      shopId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      action: {
        type: DataTypes.ENUM(
          'arrived_pickup',
          'arrived_delivery',
          'complete_pickup',
          'complete_delivery',
          'fail_pickup',
          'fail_delivery'
        ),
        allowNull: false,
      },
      withinGeofence: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
      },
      overrideUsed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      geofenceBypassedGlobal: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      driverLat: DataTypes.DECIMAL(10, 7),
      driverLng: DataTypes.DECIMAL(10, 7),
      customerLat: DataTypes.DECIMAL(10, 7),
      customerLng: DataTypes.DECIMAL(10, 7),
      distanceMeters: DataTypes.INTEGER,
      requiredRadiusMeters: DataTypes.INTEGER,
      failInstructionSetId: DataTypes.INTEGER,
      failInstructionSetVersion: DataTypes.INTEGER,
      acknowledgedItemSnapshot: DataTypes.JSON,
      overrideReason: DataTypes.STRING(500),
    },
    {
      sequelize,
      modelName: 'agentComplianceEvent',
      tableName: 'agent_compliance_events',
    }
  );

  return agentComplianceEvent;
};

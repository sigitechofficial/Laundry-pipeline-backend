'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class adminPushLog extends Model {
    static associate(models) {
      adminPushLog.belongsTo(models.users, {
        foreignKey: 'sentByAdminId',
        as: 'sentByAdmin',
      });
    }
  }

  adminPushLog.init(
    {
      audience: {
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      mode: {
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      title: {
        type: DataTypes.STRING(160),
        allowNull: false,
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      targetedUsers: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      usersDelivered: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      usersNoToken: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      usersFailed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      deviceSuccessCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      deviceFailureCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      sentByAdminId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      payloadJson: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'adminPushLog',
      tableName: 'admin_push_logs',
    }
  );

  return adminPushLog;
};

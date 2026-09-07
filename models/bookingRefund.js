'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class bookingRefund extends Model {
    static associate(models) {
      bookingRefund.belongsTo(models.booking, {
        foreignKey: 'bookingId',
        as: 'booking',
      });
      bookingRefund.belongsTo(models.users, {
        foreignKey: 'adminUserId',
        as: 'admin',
      });
    }
  }

  bookingRefund.init(
    {
      bookingId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      adminUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      mode: {
        type: DataTypes.ENUM('full', 'partial'),
        allowNull: false,
        defaultValue: 'partial',
      },
      channel: {
        type: DataTypes.ENUM('card', 'cash', 'mixed'),
        allowNull: false,
        defaultValue: 'card',
      },
      amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      currency: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'GBP',
      },
      reason: {
        type: DataTypes.STRING(500),
        allowNull: false,
      },
      note: {
        type: DataTypes.STRING(1000),
        allowNull: true,
      },
      stripeRefundIds: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      paymentAllocations: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      commissionClawback: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      platformShareClawback: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      cashCollectedReversal: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      extraTipClawback: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      refundSharePercent: {
        type: DataTypes.DECIMAL(8, 4),
        allowNull: false,
        defaultValue: 0,
      },
      breakdown: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('succeeded', 'partial_failed', 'failed'),
        allowNull: false,
        defaultValue: 'succeeded',
      },
      idempotencyKey: {
        type: DataTypes.STRING(255),
        allowNull: true,
        unique: true,
      },
    },
    {
      sequelize,
      modelName: 'bookingRefund',
      tableName: 'booking_refunds',
      paranoid: true,
    }
  );

  return bookingRefund;
};

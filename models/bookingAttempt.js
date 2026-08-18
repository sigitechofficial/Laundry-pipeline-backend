'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class bookingAttempt extends Model {
        static associate(models) {
            bookingAttempt.belongsTo(models.booking, { foreignKey: 'bookingId', as: 'booking' });
            bookingAttempt.belongsTo(models.users, { foreignKey: 'driverId', as: 'driver' });
            bookingAttempt.belongsTo(models.policy, { foreignKey: 'noShowPolicyId', as: 'noShowPolicy' });
            bookingAttempt.belongsTo(models.attemptFailReason, {
                foreignKey: 'failureReasonId',
                as: 'failReason',
            });
            bookingAttempt.hasMany(models.bookingNotification, {
                foreignKey: 'attemptId',
                as: 'notifications',
            });
        }
    }

    bookingAttempt.init(
        {
            bookingId: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            attemptType: {
                type: DataTypes.ENUM('pickup', 'delivery'),
                allowNull: false,
            },
            attemptNumber: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 1,
            },
            status: {
                type: DataTypes.ENUM('arrived', 'completed', 'unattended', 'failed', 'superseded'),
                allowNull: false,
                defaultValue: 'arrived',
            },
            arrivedAt: {
                type: DataTypes.DATE,
                allowNull: false,
            },
            completedAt: DataTypes.DATE,
            failedAt: DataTypes.DATE,
            driverId: DataTypes.INTEGER,
            driverLateMinutes: DataTypes.INTEGER,
            feeAmount: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 0,
            },
            feeCurrency: {
                type: DataTypes.STRING(10),
                allowNull: true,
                defaultValue: 'USD',
            },
            feeWaived: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
            feeWaiveReason: DataTypes.STRING(255),
            failureReason: DataTypes.STRING(500),
            failureReasonId: DataTypes.INTEGER,
            failureReasonCode: DataTypes.STRING(64),
            failureReasonNote: DataTypes.STRING(500),
            failureChargesFee: DataTypes.BOOLEAN,
            unattendedMethod: {
                type: DataTypes.ENUM('bag_at_door', 'concierge', 'locker'),
                allowNull: true,
            },
            noShowPolicyId: DataTypes.INTEGER,
        },
        {
            sequelize,
            modelName: 'bookingAttempt',
            tableName: 'booking_attempts',
            timestamps: true,
        }
    );

    return bookingAttempt;
};

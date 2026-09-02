'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class bookingNotification extends Model {
        static associate(models) {
            bookingNotification.belongsTo(models.booking, {
                foreignKey: 'bookingId',
                as: 'booking',
            });
            bookingNotification.belongsTo(models.bookingAttempt, {
                foreignKey: 'attemptId',
                as: 'attempt',
            });
            bookingNotification.belongsTo(models.users, {
                foreignKey: 'agentUserId',
                as: 'agent',
            });
        }
    }

    bookingNotification.init(
        {
            bookingId: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            attemptId: {
                type: DataTypes.INTEGER,
                allowNull: true,
            },
            leg: {
                type: DataTypes.ENUM('pickup', 'delivery'),
                allowNull: false,
            },
            channel: {
                type: DataTypes.ENUM('sms', 'call', 'push'),
                allowNull: false,
                defaultValue: 'sms',
            },
            agentUserId: {
                type: DataTypes.INTEGER,
                allowNull: true,
            },
            twilioSid: {
                type: DataTypes.STRING(64),
                allowNull: true,
            },
            twilioStatus: {
                type: DataTypes.STRING(32),
                allowNull: true,
            },
            bodyPreview: {
                type: DataTypes.STRING(200),
                allowNull: true,
            },
            toMasked: {
                type: DataTypes.STRING(32),
                allowNull: true,
            },
            fromNumber: {
                type: DataTypes.STRING(32),
                allowNull: true,
            },
            sentAt: {
                type: DataTypes.DATE,
                allowNull: false,
            },
            deliveredAt: {
                type: DataTypes.DATE,
                allowNull: true,
            },
        },
        {
            sequelize,
            modelName: 'bookingNotification',
            tableName: 'booking_notifications',
            timestamps: true,
        }
    );

    return bookingNotification;
};

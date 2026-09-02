'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class bookingCallSession extends Model {
        static associate(models) {
            bookingCallSession.belongsTo(models.booking, {
                foreignKey: 'bookingId',
                as: 'booking',
            });
            bookingCallSession.belongsTo(models.users, {
                foreignKey: 'agentUserId',
                as: 'agent',
            });
        }
    }

    bookingCallSession.init(
        {
            bookingId: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            agentUserId: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            leg: {
                type: DataTypes.ENUM('pickup', 'delivery'),
                allowNull: false,
            },
            agentPhoneE164: {
                type: DataTypes.STRING(32),
                allowNull: false,
            },
            status: {
                type: DataTypes.ENUM('active', 'closed', 'expired'),
                allowNull: false,
                defaultValue: 'active',
            },
            expiresAt: {
                type: DataTypes.DATE,
                allowNull: false,
            },
            closedAt: {
                type: DataTypes.DATE,
                allowNull: true,
            },
            closeReason: {
                type: DataTypes.STRING(64),
                allowNull: true,
            },
            callSid: {
                type: DataTypes.STRING(64),
                allowNull: true,
            },
            callStatus: {
                type: DataTypes.STRING(32),
                allowNull: true,
            },
            callDurationSec: {
                type: DataTypes.INTEGER,
                allowNull: true,
            },
            connectedAt: {
                type: DataTypes.DATE,
                allowNull: true,
            },
            endedAt: {
                type: DataTypes.DATE,
                allowNull: true,
            },
        },
        {
            sequelize,
            modelName: 'bookingCallSession',
            tableName: 'booking_call_sessions',
            timestamps: true,
        }
    );

    return bookingCallSession;
};

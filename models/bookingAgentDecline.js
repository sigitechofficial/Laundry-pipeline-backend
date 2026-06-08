'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class bookingAgentDecline extends Model {
        static associate(models) {
            bookingAgentDecline.belongsTo(models.booking, {
                foreignKey: 'bookingId',
            });
            bookingAgentDecline.belongsTo(models.users, {
                foreignKey: 'agentUserId',
                as: 'agent',
            });
        }
    }

    bookingAgentDecline.init(
        {
            bookingId: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            agentUserId: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            reason: {
                type: DataTypes.STRING(500),
                allowNull: true,
            },
        },
        {
            sequelize,
            modelName: 'bookingAgentDecline',
            tableName: 'bookingAgentDeclines',
        }
    );

    return bookingAgentDecline;
};

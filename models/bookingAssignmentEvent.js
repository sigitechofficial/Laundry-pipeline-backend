'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class bookingAssignmentEvent extends Model {
        static associate(models) {
            bookingAssignmentEvent.belongsTo(models.booking, {
                foreignKey: 'bookingId',
            });
            bookingAssignmentEvent.belongsTo(models.users, {
                foreignKey: 'fromUserId',
                as: 'fromUser',
            });
            bookingAssignmentEvent.belongsTo(models.users, {
                foreignKey: 'toUserId',
                as: 'toUser',
            });
            bookingAssignmentEvent.belongsTo(models.users, {
                foreignKey: 'actedByUserId',
                as: 'actedByUser',
            });
        }
    }

    bookingAssignmentEvent.init(
        {
            bookingId: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            assignmentType: {
                type: DataTypes.STRING(20),
                allowNull: false,
            },
            action: {
                type: DataTypes.STRING(20),
                allowNull: false,
            },
            fromUserId: {
                type: DataTypes.INTEGER,
                allowNull: true,
            },
            toUserId: {
                type: DataTypes.INTEGER,
                allowNull: true,
            },
            actedByUserId: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            source: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: 'manual',
            },
        },
        {
            sequelize,
            modelName: 'bookingAssignmentEvent',
            tableName: 'bookingAssignmentEvents',
        }
    );

    return bookingAssignmentEvent;
};

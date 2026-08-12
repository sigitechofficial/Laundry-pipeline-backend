'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class staffUnassignReason extends Model {
        static associate(models) {
            staffUnassignReason.hasMany(models.bookingAssignmentEvent, {
                foreignKey: 'reasonId',
                as: 'assignmentEvents',
            });
        }
    }

    staffUnassignReason.init(
        {
            label: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            sortOrder: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            status: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true,
            },
            isOther: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
        },
        {
            sequelize,
            modelName: 'staffUnassignReason',
            tableName: 'staffUnassignReasons',
        }
    );

    return staffUnassignReason;
};

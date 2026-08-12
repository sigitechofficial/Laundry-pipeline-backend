'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class employeeCapabilityOverride extends Model {
        static associate(models) {
            employeeCapabilityOverride.belongsTo(models.users, {
                foreignKey: 'userId',
            });
        }
    }

    employeeCapabilityOverride.init(
        {
            userId: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            capabilityKey: {
                type: DataTypes.STRING(64),
                allowNull: false,
            },
            allowed: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
            },
        },
        {
            sequelize,
            modelName: 'employeeCapabilityOverride',
            tableName: 'employeeCapabilityOverrides',
        }
    );

    return employeeCapabilityOverride;
};

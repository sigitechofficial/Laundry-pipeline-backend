'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class shopAutoAssignSetting extends Model {
        static associate(models) {
            shopAutoAssignSetting.belongsTo(models.users, {
                foreignKey: 'shopUserId',
                as: 'shopOwner',
            });
        }
    }

    shopAutoAssignSetting.init(
        {
            shopUserId: {
                type: DataTypes.INTEGER,
                allowNull: false,
                unique: true,
            },
            enabled: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
            strategy: {
                type: DataTypes.STRING(32),
                allowNull: false,
                defaultValue: 'round_robin',
            },
            scope: {
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: 'both',
            },
            fallbackToOwner: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true,
            },
        },
        {
            sequelize,
            modelName: 'shopAutoAssignSetting',
            tableName: 'shopAutoAssignSettings',
        }
    );

    return shopAutoAssignSetting;
};

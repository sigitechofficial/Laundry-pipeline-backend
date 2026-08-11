'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class adminNotificationPreference extends Model {
        static associate(models) {
            adminNotificationPreference.belongsTo(models.users, {
                foreignKey: 'adminUserId',
                as: 'adminUser',
            });
        }
    }

    adminNotificationPreference.init(
        {
            adminUserId: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            alertType: {
                type: DataTypes.STRING(64),
                allowNull: false,
            },
            enabled: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true,
            },
        },
        {
            sequelize,
            modelName: 'adminNotificationPreference',
            tableName: 'admin_notification_preferences',
        }
    );

    return adminNotificationPreference;
};

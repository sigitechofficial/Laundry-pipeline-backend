'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class customerOriginalPreferenceSnapshot extends Model {
        static associate(models) {
            customerOriginalPreferenceSnapshot.belongsTo(models.booking, {
                foreignKey: 'bookingId',
                as: 'booking'
            });
            customerOriginalPreferenceSnapshot.belongsTo(models.customerOriginalServiceSnapshot, {
                foreignKey: 'snapshotServiceId',
                as: 'snapshotService'
            });
            customerOriginalPreferenceSnapshot.belongsTo(models.preferenceTypes, {
                foreignKey: 'preferenceTypeId',
                as: 'preferenceType'
            });
            customerOriginalPreferenceSnapshot.belongsTo(models.preferenceValues, {
                foreignKey: 'preferenceValueId',
                as: 'preferenceValue'
            });
        }
    }

    customerOriginalPreferenceSnapshot.init({
        bookingId: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        snapshotServiceId: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        preferenceTypeId: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        preferenceValueId: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        parentPreferenceValueId: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        preferenceInstruction: {
            type: DataTypes.TEXT,
            allowNull: true
        }
    }, {
        sequelize,
        modelName: 'customerOriginalPreferenceSnapshot',
        tableName: 'customerOriginalPreferenceSnapshots'
    });

    return customerOriginalPreferenceSnapshot;
};

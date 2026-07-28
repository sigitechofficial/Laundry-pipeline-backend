'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class customerOriginalServiceSnapshot extends Model {
        static associate(models) {
            customerOriginalServiceSnapshot.belongsTo(models.booking, {
                foreignKey: 'bookingId',
                as: 'booking'
            });
            customerOriginalServiceSnapshot.belongsTo(models.service, {
                foreignKey: 'serviceId',
                as: 'service'
            });
            customerOriginalServiceSnapshot.belongsTo(models.categories, {
                foreignKey: 'categoryId',
                as: 'category'
            });
            customerOriginalServiceSnapshot.belongsTo(models.subCategories, {
                foreignKey: 'subCategoryId',
                as: 'subCategory'
            });
            customerOriginalServiceSnapshot.hasMany(models.customerOriginalPreferenceSnapshot, {
                foreignKey: 'snapshotServiceId',
                as: 'preferences'
            });
        }
    }

    customerOriginalServiceSnapshot.init({
        bookingId: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        serviceId: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        categoryId: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        subCategoryId: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        items: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        bags: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        categoryPrice: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true
        },
        serviceInstruction: {
            type: DataTypes.TEXT,
            allowNull: true
        }
    }, {
        sequelize,
        modelName: 'customerOriginalServiceSnapshot',
        tableName: 'customerOriginalServiceSnapshots'
    });

    return customerOriginalServiceSnapshot;
};

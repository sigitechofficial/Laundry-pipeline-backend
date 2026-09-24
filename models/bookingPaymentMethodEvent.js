'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class bookingPaymentMethodEvent extends Model {
        static associate(models) {
            bookingPaymentMethodEvent.belongsTo(models.booking, {
                foreignKey: 'bookingId',
            });
            bookingPaymentMethodEvent.belongsTo(models.users, {
                foreignKey: 'actedByUserId',
                as: 'actedByUser',
            });
        }
    }

    bookingPaymentMethodEvent.init(
        {
            bookingId: { type: DataTypes.INTEGER, allowNull: false },
            field: {
                type: DataTypes.STRING(32),
                allowNull: false,
                defaultValue: 'balancePaymentMethod',
            },
            fromMethod: { type: DataTypes.STRING(16), allowNull: true },
            toMethod: { type: DataTypes.STRING(16), allowNull: false },
            actedByUserId: { type: DataTypes.INTEGER, allowNull: true },
            actorType: {
                type: DataTypes.STRING(16),
                allowNull: false,
                defaultValue: 'admin',
            },
            reasonCode: { type: DataTypes.STRING(64), allowNull: true },
            reasonText: { type: DataTypes.STRING(255), allowNull: true },
            note: { type: DataTypes.TEXT, allowNull: true },
            amountDueSnapshot: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
        },
        {
            sequelize,
            modelName: 'bookingPaymentMethodEvent',
            tableName: 'bookingPaymentMethodEvents',
        }
    );

    return bookingPaymentMethodEvent;
};

"use strict";
const { Model } = require("sequelize");

module.exports = (sequelize, DataTypes) => {
    class invoicePaymentAttempt extends Model {
        static associate(models) {
            invoicePaymentAttempt.belongsTo(models.booking, {
                foreignKey: "bookingId",
                as: "booking",
            });
            invoicePaymentAttempt.belongsTo(models.users, {
                foreignKey: "agentUserId",
                as: "agent",
            });
        }
    }

    invoicePaymentAttempt.init(
        {
            bookingId: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            attemptType: {
                type: DataTypes.ENUM(
                    "scheduled_auto",
                    "ofd_retry",
                    "manual_agent",
                    "admin_retry"
                ),
                allowNull: false,
            },
            attemptNumber: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 1,
            },
            status: {
                type: DataTypes.ENUM("succeeded", "failed", "skipped"),
                allowNull: false,
            },
            amount: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 0,
            },
            currency: {
                type: DataTypes.STRING(10),
                allowNull: false,
                defaultValue: "GBP",
            },
            paymentMethodId: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            paymentIntentId: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            stripeErrorCode: {
                type: DataTypes.STRING(64),
                allowNull: true,
            },
            stripeDeclineCode: {
                type: DataTypes.STRING(64),
                allowNull: true,
            },
            errorMessage: {
                type: DataTypes.STRING(500),
                allowNull: true,
            },
            laundryShopId: {
                type: DataTypes.INTEGER,
                allowNull: true,
            },
            agentUserId: {
                type: DataTypes.INTEGER,
                allowNull: true,
            },
            triggeredBy: {
                type: DataTypes.ENUM("system", "agent", "admin"),
                allowNull: false,
                defaultValue: "system",
            },
            metadata: {
                type: DataTypes.JSON,
                allowNull: true,
            },
        },
        {
            sequelize,
            modelName: "invoicePaymentAttempt",
            tableName: "invoice_payment_attempts",
        }
    );

    return invoicePaymentAttempt;
};

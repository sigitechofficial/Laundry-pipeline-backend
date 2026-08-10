"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await addColumnIfMissing(queryInterface, "bookings", "invoiceFinalizedAt", {
            type: Sequelize.DATE,
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, "bookings", "autoChargeStatus", {
            type: Sequelize.ENUM(
                "none",
                "scheduled",
                "processing",
                "succeeded",
                "failed",
                "cancelled",
                "skipped"
            ),
            allowNull: false,
            defaultValue: "none",
        });
        await addColumnIfMissing(queryInterface, "bookings", "autoChargeDueAt", {
            type: Sequelize.DATE,
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, "bookings", "autoChargeAttemptCount", {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
        });
        await addColumnIfMissing(queryInterface, "bookings", "autoChargeLastAttemptAt", {
            type: Sequelize.DATE,
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, "bookings", "lastPaymentFailureCode", {
            type: Sequelize.STRING(64),
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, "bookings", "lastPaymentFailureMessage", {
            type: Sequelize.STRING(500),
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, "bookings", "lastPaymentFailureAt", {
            type: Sequelize.DATE,
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, "bookings", "paymentDeliveryGate", {
            type: Sequelize.ENUM(
                "open",
                "waiting_admin",
                "cleared_cash",
                "cleared_allow"
            ),
            allowNull: false,
            defaultValue: "open",
        });
        await addColumnIfMissing(queryInterface, "bookings", "ofdAutoRetryDone", {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        });
        await addColumnIfMissing(queryInterface, "bookings", "paymentAdminResolvedAt", {
            type: Sequelize.DATE,
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, "bookings", "paymentAdminResolvedBy", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
        });
        await addColumnIfMissing(queryInterface, "bookings", "paymentAdminNotes", {
            type: Sequelize.STRING(500),
            allowNull: true,
        });

        await queryInterface.createTable("invoice_payment_attempts", {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER,
            },
            bookingId: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: "bookings", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
            },
            attemptType: {
                type: Sequelize.ENUM(
                    "scheduled_auto",
                    "ofd_retry",
                    "manual_agent",
                    "admin_retry"
                ),
                allowNull: false,
            },
            attemptNumber: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 1,
            },
            status: {
                type: Sequelize.ENUM("succeeded", "failed", "skipped"),
                allowNull: false,
            },
            amount: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 0,
            },
            currency: {
                type: Sequelize.STRING(10),
                allowNull: false,
                defaultValue: "GBP",
            },
            paymentMethodId: {
                type: Sequelize.STRING,
                allowNull: true,
            },
            paymentIntentId: {
                type: Sequelize.STRING,
                allowNull: true,
            },
            stripeErrorCode: {
                type: Sequelize.STRING(64),
                allowNull: true,
            },
            stripeDeclineCode: {
                type: Sequelize.STRING(64),
                allowNull: true,
            },
            errorMessage: {
                type: Sequelize.STRING(500),
                allowNull: true,
            },
            laundryShopId: {
                type: Sequelize.INTEGER,
                allowNull: true,
            },
            agentUserId: {
                type: Sequelize.INTEGER,
                allowNull: true,
            },
            triggeredBy: {
                type: Sequelize.ENUM("system", "agent", "admin"),
                allowNull: false,
                defaultValue: "system",
            },
            metadata: {
                type: Sequelize.JSON,
                allowNull: true,
            },
            createdAt: {
                allowNull: false,
                type: Sequelize.DATE,
            },
            updatedAt: {
                allowNull: false,
                type: Sequelize.DATE,
            },
        });

        await queryInterface.addIndex("invoice_payment_attempts", ["bookingId"], {
            name: "invoice_payment_attempts_booking_id_idx",
        });
        await queryInterface.addIndex("bookings", ["autoChargeStatus", "autoChargeDueAt"], {
            name: "bookings_auto_charge_due_idx",
        });
        await queryInterface.addIndex("bookings", ["paymentDeliveryGate"], {
            name: "bookings_payment_delivery_gate_idx",
        });
    },

    async down(queryInterface) {
        await queryInterface.removeIndex(
            "bookings",
            "bookings_payment_delivery_gate_idx"
        ).catch(() => {});
        await queryInterface.removeIndex(
            "bookings",
            "bookings_auto_charge_due_idx"
        ).catch(() => {});
        await queryInterface.removeIndex(
            "invoice_payment_attempts",
            "invoice_payment_attempts_booking_id_idx"
        ).catch(() => {});
        await queryInterface.dropTable("invoice_payment_attempts");

        const bookingCols = [
            "invoiceFinalizedAt",
            "autoChargeStatus",
            "autoChargeDueAt",
            "autoChargeAttemptCount",
            "autoChargeLastAttemptAt",
            "lastPaymentFailureCode",
            "lastPaymentFailureMessage",
            "lastPaymentFailureAt",
            "paymentDeliveryGate",
            "ofdAutoRetryDone",
            "paymentAdminResolvedAt",
            "paymentAdminResolvedBy",
            "paymentAdminNotes",
        ];
        for (const col of bookingCols) {
            await removeColumnIfExists(queryInterface, "bookings", col).catch(() => {});
        }
    },
};

"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const table = await queryInterface.describeTable("wallets");

        if (!table.userId) {
            await addColumnIfMissing(queryInterface, "wallets", "userId", {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "users", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            });
        }

        if (!table.bookingId) {
            await addColumnIfMissing(queryInterface, "wallets", "bookingId", {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: "bookings", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
            });
        }

        if (!table.referenceType) {
            await addColumnIfMissing(queryInterface, "wallets", "referenceType", {
                type: Sequelize.STRING(64),
                allowNull: true,
                defaultValue: "",
            });
        }

        try {
            await queryInterface.addIndex("wallets", {
                name: "wallets_user_booking_reference_unique",
                fields: ["userId", "bookingId", "referenceType"],
                unique: true,
            });
        } catch (err) {
            if (!String(err.message).includes("Duplicate")) {
                console.warn("wallets unique index:", err.message);
            }
        }

        try {
            await queryInterface.addIndex("wallets", {
                name: "wallets_user_id_created_at",
                fields: ["userId", "createdAt"],
            });
        } catch (err) {
            if (!String(err.message).includes("Duplicate")) {
                console.warn("wallets user index:", err.message);
            }
        }
    },

    async down(queryInterface) {
        const table = await queryInterface.describeTable("wallets");

        try {
            await queryInterface.removeIndex(
                "wallets",
                "wallets_user_booking_reference_unique"
            );
        } catch (_) {
            /* ignore */
        }
        try {
            await queryInterface.removeIndex("wallets", "wallets_user_id_created_at");
        } catch (_) {
            /* ignore */
        }

        if (table.referenceType) {
            await removeColumnIfExists(queryInterface, "wallets", "referenceType");
        }
        if (table.bookingId) {
            await removeColumnIfExists(queryInterface, "wallets", "bookingId");
        }
        if (table.userId) {
            await removeColumnIfExists(queryInterface, "wallets", "userId");
        }
    },
};

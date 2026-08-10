"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const table = await queryInterface.describeTable("wallets");

        if (!table.stripeTransferId) {
            await addColumnIfMissing(queryInterface, "wallets", "stripeTransferId", {
                type: Sequelize.STRING(255),
                allowNull: true,
            });
        }

        if (!table.failureReason) {
            await addColumnIfMissing(queryInterface, "wallets", "failureReason", {
                type: Sequelize.STRING(500),
                allowNull: true,
            });
        }

        try {
            await queryInterface.addIndex("wallets", {
                name: "wallets_stripe_transfer_id_unique",
                fields: ["stripeTransferId"],
                unique: true,
            });
        } catch (err) {
            if (!String(err.message).includes("Duplicate")) {
                throw err;
            }
        }
    },

    async down(queryInterface) {
        const table = await queryInterface.describeTable("wallets");

        try {
            await queryInterface.removeIndex(
                "wallets",
                "wallets_stripe_transfer_id_unique"
            );
        } catch (_) {
            /* ignore */
        }

        if (table.failureReason) {
            await removeColumnIfExists(queryInterface, "wallets", "failureReason");
        }
        if (table.stripeTransferId) {
            await removeColumnIfExists(queryInterface, "wallets", "stripeTransferId");
        }
    },
};

"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const zonesTable = await queryInterface.describeTable("zones");
        if (!zonesTable.agentCommissionPercent) {
            await addColumnIfMissing(queryInterface, "zones", "agentCommissionPercent", {
                type: Sequelize.INTEGER,
                allowNull: true,
                comment: "Percent of order total paid to agent/shop",
            });
        }

        const billingTable = await queryInterface.describeTable("billingDetails");
        if (!billingTable.agentEarning) {
            await addColumnIfMissing(queryInterface, "billingDetails", "agentEarning", {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: true,
                comment: "Agent shop earning for this booking",
            });
        }

        await queryInterface.sequelize.query(`
            UPDATE zones
            SET agentCommissionPercent = 100 - zoneAdminComission
            WHERE agentCommissionPercent IS NULL
              AND zoneAdminComission IS NOT NULL
        `);

        await queryInterface.sequelize.query(`
            UPDATE zones
            SET agentCommissionPercent = 80
            WHERE agentCommissionPercent IS NULL
        `);

        // Only backfill when bookings.zoneId exists (added in 20250120110000 on greenfield).
        const bookingTable = await queryInterface.describeTable("bookings");
        if (bookingTable.zoneId) {
            await queryInterface.sequelize.query(`
                UPDATE billingDetails bd
                INNER JOIN bookings b ON b.id = bd.bookingId
                INNER JOIN zones z ON z.id = b.zoneId
                SET bd.agentEarning = ROUND(
                    bd.total * (COALESCE(z.agentCommissionPercent, 100 - COALESCE(z.zoneAdminComission, 20)) / 100),
                    2
                )
                WHERE bd.agentEarning IS NULL
                  AND bd.total IS NOT NULL
                  AND bd.total > 0
                  AND b.zoneId IS NOT NULL
            `);
        }
    },

    async down(queryInterface) {
        const zonesTable = await queryInterface.describeTable("zones");
        if (zonesTable.agentCommissionPercent) {
            await removeColumnIfExists(queryInterface, "zones", "agentCommissionPercent");
        }

        const billingTable = await queryInterface.describeTable("billingDetails");
        if (billingTable.agentEarning) {
            await removeColumnIfExists(queryInterface, "billingDetails", "agentEarning");
        }
    },
};

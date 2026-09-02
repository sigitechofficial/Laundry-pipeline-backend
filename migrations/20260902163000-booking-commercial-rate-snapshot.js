"use strict";

const {
    tableExists,
    addColumnIfMissing,
    removeColumnIfExists,
} = require("../utils/migrationHelpers");

/**
 * Freeze zone min / service fee / commission on the booking at accept
 * (policies-style snapshot). Unaccepted rows stay null so live zone still applies.
 */
module.exports = {
    async up(queryInterface, Sequelize) {
        if (!(await tableExists(queryInterface, "bookings"))) return;

        await addColumnIfMissing(queryInterface, "bookings", "appliedZoneMinimum", {
            type: Sequelize.DECIMAL(10, 2),
            allowNull: true,
            comment: "Zone minimum frozen at accept/assign",
        });
        await addColumnIfMissing(queryInterface, "bookings", "appliedServiceCharge", {
            type: Sequelize.DECIMAL(10, 2),
            allowNull: true,
            comment: "Zone service fee frozen at accept/assign",
        });
        await addColumnIfMissing(
            queryInterface,
            "bookings",
            "appliedAgentCommissionPercent",
            {
                type: Sequelize.INTEGER,
                allowNull: true,
                comment: "Agent commission % frozen at accept/assign",
            }
        );
        await addColumnIfMissing(
            queryInterface,
            "bookings",
            "appliedPlatformCommissionPercent",
            {
                type: Sequelize.INTEGER,
                allowNull: true,
                comment: "Platform commission % frozen at accept/assign",
            }
        );
        await addColumnIfMissing(queryInterface, "bookings", "rateSnapshotLockedAt", {
            type: Sequelize.DATE,
            allowNull: true,
            comment: "When commercial terms were frozen",
        });
        await addColumnIfMissing(queryInterface, "bookings", "rateSnapshotSource", {
            type: Sequelize.STRING(32),
            allowNull: true,
            comment: "accepted | assigned | backfill",
        });

        // Already-accepted orders: freeze current billing + live zone so later
        // zone edits cannot rewrite in-flight invoices.
        await queryInterface.sequelize.query(`
            UPDATE bookings b
            LEFT JOIN billingDetails bd ON bd.bookingId = b.id
            LEFT JOIN zones z ON z.id = b.zoneId
            SET
                b.appliedZoneMinimum = COALESCE(bd.upfrontAmount, z.zoneMinimumAmount),
                b.appliedServiceCharge = COALESCE(bd.serviceCharge, z.serviceCharge),
                b.appliedAgentCommissionPercent = COALESCE(
                    z.agentCommissionPercent,
                    100 - COALESCE(z.zoneAdminComission, 20),
                    80
                ),
                b.appliedPlatformCommissionPercent = COALESCE(
                    z.zoneAdminComission,
                    100 - COALESCE(z.agentCommissionPercent, 80),
                    20
                ),
                b.rateSnapshotLockedAt = UTC_TIMESTAMP(),
                b.rateSnapshotSource = 'backfill'
            WHERE b.deletedAt IS NULL
              AND b.laundryShopId IS NOT NULL
              AND b.rateSnapshotLockedAt IS NULL
        `);
    },

    async down(queryInterface) {
        await removeColumnIfExists(queryInterface, "bookings", "rateSnapshotSource");
        await removeColumnIfExists(queryInterface, "bookings", "rateSnapshotLockedAt");
        await removeColumnIfExists(
            queryInterface,
            "bookings",
            "appliedPlatformCommissionPercent"
        );
        await removeColumnIfExists(
            queryInterface,
            "bookings",
            "appliedAgentCommissionPercent"
        );
        await removeColumnIfExists(queryInterface, "bookings", "appliedServiceCharge");
        await removeColumnIfExists(queryInterface, "bookings", "appliedZoneMinimum");
    },
};

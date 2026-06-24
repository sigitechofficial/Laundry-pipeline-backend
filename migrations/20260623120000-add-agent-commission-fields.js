"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const zonesTable = await queryInterface.describeTable("zones");
        if (!zonesTable.agentCommissionPercent) {
            await queryInterface.addColumn("zones", "agentCommissionPercent", {
                type: Sequelize.INTEGER,
                allowNull: true,
                comment: "Percent of order total paid to agent/shop",
            });
        }

        const billingTable = await queryInterface.describeTable("billingDetails");
        if (!billingTable.agentEarning) {
            await queryInterface.addColumn("billingDetails", "agentEarning", {
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
        `);
    },

    async down(queryInterface) {
        const zonesTable = await queryInterface.describeTable("zones");
        if (zonesTable.agentCommissionPercent) {
            await queryInterface.removeColumn("zones", "agentCommissionPercent");
        }

        const billingTable = await queryInterface.describeTable("billingDetails");
        if (billingTable.agentEarning) {
            await queryInterface.removeColumn("billingDetails", "agentEarning");
        }
    },
};

"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const table = await queryInterface.describeTable("bookings");

        if (!table.pickupRescheduleRequired) {
            await queryInterface.addColumn(
                "bookings",
                "pickupRescheduleRequired",
                {
                    type: Sequelize.BOOLEAN,
                    allowNull: false,
                    defaultValue: false,
                    comment:
                        "True only while a failed pickup attempt needs customer rescheduling",
                }
            );
        }

        // Preserve unresolved failures created before this explicit state flag.
        // Previously they were identified only by status 3 + a positive count.
        await queryInterface.sequelize.query(`
            UPDATE bookings
            SET pickupRescheduleRequired = 1
            WHERE deletedAt IS NULL
              AND bookingStatusId = 3
              AND pickupAttemptCount > 0
        `);
    },

    async down(queryInterface) {
        const table = await queryInterface.describeTable("bookings");
        if (table.pickupRescheduleRequired) {
            await queryInterface.removeColumn(
                "bookings",
                "pickupRescheduleRequired"
            );
        }
    },
};

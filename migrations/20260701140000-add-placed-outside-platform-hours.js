"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const table = await queryInterface.describeTable("bookings");

        if (!table.placedOutsidePlatformHours) {
            await queryInterface.addColumn(
                "bookings",
                "placedOutsidePlatformHours",
                {
                    type: Sequelize.BOOLEAN,
                    allowNull: false,
                    defaultValue: false,
                }
            );
        }
    },

    async down(queryInterface) {
        const table = await queryInterface.describeTable("bookings");

        if (table.placedOutsidePlatformHours) {
            await queryInterface.removeColumn(
                "bookings",
                "placedOutsidePlatformHours"
            );
        }
    },
};

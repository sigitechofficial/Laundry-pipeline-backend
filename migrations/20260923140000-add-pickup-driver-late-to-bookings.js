'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/**
 * Marks a booking whose pickup attempt failed because the DRIVER arrived after
 * the scheduled pickup window. Used to waive the customer reschedule fee (no
 * penalty when it's the driver's fault). Idempotent.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
    async up(queryInterface, Sequelize) {
        await addColumnIfMissing(queryInterface, 'bookings', 'pickupDriverLate', {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        });
    },

    async down(queryInterface) {
        await removeColumnIfExists(queryInterface, 'bookings', 'pickupDriverLate');
    },
};

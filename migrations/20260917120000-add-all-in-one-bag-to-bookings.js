'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/**
 * `bookings.allInOneBag` has been selected by the admin order list
 * (services/Admin/orderService.js) since c3736e2, but only ever existed on the
 * live stage/prod databases (added out-of-band). Any fresh environment 500s on
 * every order list with "Unknown column 'booking.allInOneBag'". Track it in a
 * migration so ensure-live-migrations can heal drift and fresh DBs match code.
 * Idempotent: no-op where the column already exists.
 */
module.exports = {
    async up(queryInterface, Sequelize) {
        await addColumnIfMissing(queryInterface, 'bookings', 'allInOneBag', {
            type: Sequelize.BOOLEAN,
            allowNull: true,
            defaultValue: null,
        });
    },

    async down(queryInterface) {
        await removeColumnIfExists(queryInterface, 'bookings', 'allInOneBag');
    },
};

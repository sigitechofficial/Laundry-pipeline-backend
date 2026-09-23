'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/**
 * Admin-configurable toggle: when ON (default), the customer no-show /
 * reschedule penalty is waived if the driver arrives after the scheduled
 * window (beyond the driverLateSLA grace minutes). Lets admins enable or
 * disable the "no penalty when driver is late" behavior per no-show policy.
 * Idempotent.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
    async up(queryInterface, Sequelize) {
        await addColumnIfMissing(queryInterface, 'no_show_policy_configs', 'waiveFeeIfDriverLate', {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: true,
        });
    },

    async down(queryInterface) {
        await removeColumnIfExists(queryInterface, 'no_show_policy_configs', 'waiveFeeIfDriverLate');
    },
};

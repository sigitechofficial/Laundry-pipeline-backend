'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const table = await queryInterface.describeTable('no_show_policy_configs');
        if (!table.arrivalRadiusMeters) {
            await queryInterface.addColumn('no_show_policy_configs', 'arrivalRadiusMeters', {
                type: Sequelize.INTEGER,
                allowNull: true,
                defaultValue: 100,
                comment: 'Geofence radius (meters) for Arrived / no-show / unattended',
            });
        }
    },

    async down(queryInterface) {
        const table = await queryInterface.describeTable('no_show_policy_configs');
        if (table.arrivalRadiusMeters) {
            await queryInterface.removeColumn('no_show_policy_configs', 'arrivalRadiusMeters');
        }
    },
};

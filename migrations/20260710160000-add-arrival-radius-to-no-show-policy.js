'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'no_show_policy_configs', 'arrivalRadiusMeters', {
                type: Sequelize.INTEGER,
                allowNull: true,
                defaultValue: 100,
                comment: 'Geofence radius (meters) for Arrived / no-show / unattended',
            });
  },
  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'no_show_policy_configs', 'arrivalRadiusMeters');
  },
};

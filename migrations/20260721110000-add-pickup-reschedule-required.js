'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'bookings', 'pickupRescheduleRequired', {
                    type: Sequelize.BOOLEAN,
                    allowNull: false,
                    defaultValue: false,
                    comment:
                        "True only while a failed pickup attempt needs customer rescheduling",
                });
  },
  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'bookings', 'pickupRescheduleRequired');
  },
};

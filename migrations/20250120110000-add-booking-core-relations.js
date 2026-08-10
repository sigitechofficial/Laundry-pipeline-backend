'use strict';

/**
 * Core booking relation columns historically created via sequelize.sync, not migrations.
 * Without these, greenfield `db:migrate` produces a bookings table the app cannot use
 * and later data migrations fail (e.g. b.zoneId).
 */
const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

const COLUMNS = [
  ['customerId', (Sequelize) => ({ type: Sequelize.INTEGER, allowNull: true })],
  ['bookingStatusId', (Sequelize) => ({ type: Sequelize.INTEGER, allowNull: true })],
  ['zoneId', (Sequelize) => ({ type: Sequelize.INTEGER, allowNull: true })],
  ['laundryShopId', (Sequelize) => ({ type: Sequelize.INTEGER, allowNull: true })],
  ['pickupAddresId', (Sequelize) => ({ type: Sequelize.INTEGER, allowNull: true })],
  ['dropOffAddressId', (Sequelize) => ({ type: Sequelize.INTEGER, allowNull: true })],
  ['categoryId', (Sequelize) => ({ type: Sequelize.INTEGER, allowNull: true })],
  ['serviceId', (Sequelize) => ({ type: Sequelize.INTEGER, allowNull: true })],
  ['subCategoryId', (Sequelize) => ({ type: Sequelize.INTEGER, allowNull: true })],
  ['vehicleTypeId', (Sequelize) => ({ type: Sequelize.INTEGER, allowNull: true })],
  ['driverId', (Sequelize) => ({ type: Sequelize.INTEGER, allowNull: true })],
  ['deliveryDriverId', (Sequelize) => ({ type: Sequelize.INTEGER, allowNull: true })],
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    for (const [name, spec] of COLUMNS) {
      await addColumnIfMissing(queryInterface, 'bookings', name, spec(Sequelize));
    }
  },

  async down(queryInterface) {
    for (const [name] of [...COLUMNS].reverse()) {
      await removeColumnIfExists(queryInterface, 'bookings', name);
    }
  },
};

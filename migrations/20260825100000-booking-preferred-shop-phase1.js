'use strict';
const { addColumnIfMissing } = require('../utils/migrationHelpers');

module.exports = {
  async up(queryInterface, Sequelize) {
    // Phase-1 preferred shop: the agent (user) who last completed an order for
    // this customer gets a private head-start window before all other shops see
    // the booking.  If they don't accept within the window the booking is
    // automatically broadcast to everyone (Phase 2).
    await addColumnIfMissing(
      queryInterface, 'bookings', 'preferredShopAgentId',
      { type: Sequelize.INTEGER, allowNull: true, defaultValue: null }
    );
    await addColumnIfMissing(
      queryInterface, 'bookings', 'preferredShopExpiresAt',
      { type: Sequelize.DATE, allowNull: true, defaultValue: null }
    );
    await addColumnIfMissing(
      queryInterface, 'bookings', 'preferredShopBroadcastDone',
      { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }
    );
  },

  async down(queryInterface) {
    const { removeColumnIfExists } = require('../utils/migrationHelpers');
    await removeColumnIfExists(queryInterface, 'bookings', 'preferredShopAgentId');
    await removeColumnIfExists(queryInterface, 'bookings', 'preferredShopExpiresAt');
    await removeColumnIfExists(queryInterface, 'bookings', 'preferredShopBroadcastDone');
  },
};

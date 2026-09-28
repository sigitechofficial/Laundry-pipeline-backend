'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/**
 * Durable audit of laundry-shop assignment / reassignment on a booking.
 * fromShopId null = first assign (marketplace accept or admin).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, 'bookingShopAssignmentEvents')) {
      return;
    }

    await queryInterface.createTable('bookingShopAssignmentEvents', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      bookingId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'bookings', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      fromShopId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'addressDbs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      toShopId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'addressDbs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      actedByUserId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      source: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'admin',
        comment: 'admin | agent_accept | system',
      },
      note: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      createdAt: { allowNull: false, type: Sequelize.DATE },
      updatedAt: { allowNull: false, type: Sequelize.DATE },
    });

    await queryInterface.addIndex('bookingShopAssignmentEvents', ['bookingId'], {
      name: 'booking_shop_assignment_events_booking_id',
    });
    await queryInterface.addIndex('bookingShopAssignmentEvents', ['toShopId'], {
      name: 'booking_shop_assignment_events_to_shop_id',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'bookingShopAssignmentEvents')) {
      await queryInterface.dropTable('bookingShopAssignmentEvents');
    }
  },
};

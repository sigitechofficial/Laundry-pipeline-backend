'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('bookings');

    if (!table.pickupCompletedByUserId) {
      await queryInterface.addColumn('bookings', 'pickupCompletedByUserId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Staff who completed pickup (frozen)',
      });
    }
    if (!table.pickupCompletedAt) {
      await queryInterface.addColumn('bookings', 'pickupCompletedAt', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
    if (!table.deliveryCompletedByUserId) {
      await queryInterface.addColumn('bookings', 'deliveryCompletedByUserId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Staff who completed delivery (frozen)',
      });
    }
    if (!table.deliveryCompletedAt) {
      await queryInterface.addColumn('bookings', 'deliveryCompletedAt', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    await queryInterface.addIndex('bookings', ['pickupCompletedByUserId'], {
      name: 'bookings_pickup_completed_by_user_id',
    });
    await queryInterface.addIndex('bookings', ['deliveryCompletedByUserId'], {
      name: 'bookings_delivery_completed_by_user_id',
    });
  },

  async down(queryInterface) {
    await queryInterface
      .removeIndex('bookings', 'bookings_pickup_completed_by_user_id')
      .catch(() => {});
    await queryInterface
      .removeIndex('bookings', 'bookings_delivery_completed_by_user_id')
      .catch(() => {});
    await queryInterface
      .removeColumn('bookings', 'pickupCompletedByUserId')
      .catch(() => {});
    await queryInterface
      .removeColumn('bookings', 'pickupCompletedAt')
      .catch(() => {});
    await queryInterface
      .removeColumn('bookings', 'deliveryCompletedByUserId')
      .catch(() => {});
    await queryInterface
      .removeColumn('bookings', 'deliveryCompletedAt')
      .catch(() => {});
  },
};

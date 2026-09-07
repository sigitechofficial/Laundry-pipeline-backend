'use strict';

const { tableExists } = require('../utils/migrationHelpers');

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, 'booking_refunds')) return;

    await queryInterface.createTable('booking_refunds', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      bookingId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'bookings', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      adminUserId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      mode: {
        type: Sequelize.ENUM('full', 'partial'),
        allowNull: false,
        defaultValue: 'partial',
      },
      channel: {
        type: Sequelize.ENUM('card', 'cash', 'mixed'),
        allowNull: false,
        defaultValue: 'card',
      },
      amount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      currency: {
        type: Sequelize.STRING(10),
        allowNull: false,
        defaultValue: 'GBP',
      },
      reason: {
        type: Sequelize.STRING(500),
        allowNull: false,
      },
      note: {
        type: Sequelize.STRING(1000),
        allowNull: true,
      },
      stripeRefundIds: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      paymentAllocations: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      commissionClawback: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      platformShareClawback: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      cashCollectedReversal: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      extraTipClawback: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      refundSharePercent: {
        type: Sequelize.DECIMAL(8, 4),
        allowNull: false,
        defaultValue: 0,
      },
      breakdown: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM('succeeded', 'partial_failed', 'failed'),
        allowNull: false,
        defaultValue: 'succeeded',
      },
      idempotencyKey: {
        type: Sequelize.STRING(255),
        allowNull: true,
        unique: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      deletedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex('booking_refunds', ['bookingId'], {
      name: 'booking_refunds_booking_id',
    });
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, 'booking_refunds'))) return;
    await queryInterface.dropTable('booking_refunds');
  },
};

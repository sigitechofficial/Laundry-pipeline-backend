'use strict';

const { DataTypes } = require('sequelize');
const { tableExists } = require('../utils/migrationHelpers');

/**
 * Admin-requested Star print jobs, executed by the shop's agent app on its LAN.
 * shopUserId = laundry shop owner users.id.
 */
module.exports = {
  async up(queryInterface) {
    if (await tableExists(queryInterface, 'print_jobs')) return;

    await queryInterface.createTable('print_jobs', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      shopUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      bookingId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      kind: {
        type: DataTypes.STRING(16),
        allowNull: false,
        comment: 'tags | receipt | test',
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'pending',
        comment: 'pending | printing | printed | failed',
      },
      requestedByUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      claimedByUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      channel: {
        type: DataTypes.STRING(32),
        allowNull: true,
      },
      message: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      claimedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      completedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    });

    await queryInterface.addIndex('print_jobs', ['shopUserId', 'status'], {
      name: 'print_jobs_shop_status',
    });
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, 'print_jobs'))) return;
    await queryInterface.dropTable('print_jobs');
  },
};

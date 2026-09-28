'use strict';

const { DataTypes } = require('sequelize');
const { tableExists } = require('../utils/migrationHelpers');

/**
 * Per-shop Star Ethernet printer config (admin + future agent sync).
 * shopUserId = laundry shop owner users.id (admin ShopDetail :id).
 */
module.exports = {
  async up(queryInterface) {
    if (await tableExists(queryInterface, 'shop_printers')) return;

    await queryInterface.createTable('shop_printers', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      shopUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true,
        comment: 'users.id of laundry shop owner',
      },
      enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      ipAddress: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      port: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 9100,
      },
      paperWidthMm: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 76,
      },
      partialCut: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      shopDisplayName: {
        type: DataTypes.STRING(120),
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
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, 'shop_printers'))) return;
    await queryInterface.dropTable('shop_printers');
  },
};

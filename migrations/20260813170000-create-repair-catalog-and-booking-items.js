'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'repairGarments'))) {
      await queryInterface.createTable('repairGarments', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        name: { type: Sequelize.STRING, allowNull: false },
        description: { type: Sequelize.STRING(500), allowNull: true },
        status: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        sortOrder: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
        deletedAt: { type: Sequelize.DATE, allowNull: true },
      });
    }

    if (!(await tableExists(queryInterface, 'repairOptions'))) {
      await queryInterface.createTable('repairOptions', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        name: { type: Sequelize.STRING, allowNull: false },
        description: { type: Sequelize.STRING(500), allowNull: true },
        price: {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: false,
          defaultValue: 0,
        },
        status: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        sortOrder: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
        deletedAt: { type: Sequelize.DATE, allowNull: true },
      });
    }

    if (!(await tableExists(queryInterface, 'repairGarmentOptions'))) {
      await queryInterface.createTable('repairGarmentOptions', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        repairGarmentId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'repairGarments', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        repairOptionId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'repairOptions', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      });
      await queryInterface.addIndex(
        'repairGarmentOptions',
        ['repairGarmentId', 'repairOptionId'],
        { unique: true, name: 'repair_garment_option_unique' }
      );
    }

    if (!(await tableExists(queryInterface, 'customerSelectedRepairItems'))) {
      await queryInterface.createTable('customerSelectedRepairItems', {
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
        customerSelectedServiceId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'customerSelectedServices', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        serviceId: { type: Sequelize.INTEGER, allowNull: false },
        repairGarmentId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'repairGarments', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        garmentName: { type: Sequelize.STRING, allowNull: false },
        quantity: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1,
        },
        instruction: { type: Sequelize.TEXT, allowNull: true },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      });
      await queryInterface.addIndex(
        'customerSelectedRepairItems',
        ['bookingId'],
        { name: 'csri_booking_idx' }
      );
    }

    if (!(await tableExists(queryInterface, 'customerSelectedRepairItemOptions'))) {
      await queryInterface.createTable('customerSelectedRepairItemOptions', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        customerSelectedRepairItemId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'customerSelectedRepairItems', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        repairOptionId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'repairOptions', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        optionName: { type: Sequelize.STRING, allowNull: false },
        price: {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: false,
          defaultValue: 0,
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      });
    }

    if (!(await tableExists(queryInterface, 'customerSelectedRepairItemImages'))) {
      await queryInterface.createTable('customerSelectedRepairItemImages', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        customerSelectedRepairItemId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'customerSelectedRepairItems', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        imageUrl: { type: Sequelize.STRING, allowNull: false },
        sortOrder: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1,
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      });
    }
  },

  async down(queryInterface) {
    const tables = [
      'customerSelectedRepairItemImages',
      'customerSelectedRepairItemOptions',
      'customerSelectedRepairItems',
      'repairGarmentOptions',
      'repairOptions',
      'repairGarments',
    ];
    for (const table of tables) {
      if (await tableExists(queryInterface, table)) {
        await queryInterface.dropTable(table);
      }
    }
  },
};

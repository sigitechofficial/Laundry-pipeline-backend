'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/**
 * Admin-preferred shop for a customer (marketplace phase-1 head-start).
 * Independent of customerShopExclusions (bad-experience blocks).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, 'customerShopAssignments')) return;

    await queryInterface.createTable('customerShopAssignments', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      customerId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      shopAddressId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'addressDbs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      shopUserId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      sourceShopAddressId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'addressDbs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'active',
      },
      note: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      createdByAdminId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      unlinkedByAdminId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      unlinkedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: { allowNull: false, type: Sequelize.DATE },
      updatedAt: { allowNull: false, type: Sequelize.DATE },
    });

    await queryInterface.addIndex('customerShopAssignments', ['customerId'], {
      name: 'customer_shop_assignments_customer_id',
    });
    await queryInterface.addIndex('customerShopAssignments', ['shopAddressId'], {
      name: 'customer_shop_assignments_shop_address_id',
    });
    await queryInterface.addIndex(
      'customerShopAssignments',
      ['customerId', 'status'],
      { name: 'customer_shop_assignments_customer_status' }
    );
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'customerShopAssignments')) {
      await queryInterface.dropTable('customerShopAssignments');
    }
  },
};

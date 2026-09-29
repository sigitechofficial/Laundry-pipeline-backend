'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/**
 * Append-only audit for customer↔shop routing ops:
 * assign / reassign / unlink / relink / exclude / include.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, 'customerShopRoutingEvents')) return;

    await queryInterface.createTable('customerShopRoutingEvents', {
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
      action: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      fromShopAddressId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'addressDbs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      toShopAddressId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'addressDbs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      sourceShopAddressId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'addressDbs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      wasReturningAtFromShop: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
      },
      wasReturningAtToShop: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
      },
      adminId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      note: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      createdAt: { allowNull: false, type: Sequelize.DATE },
      updatedAt: { allowNull: false, type: Sequelize.DATE },
    });

    await queryInterface.addIndex('customerShopRoutingEvents', ['customerId'], {
      name: 'customer_shop_routing_events_customer_id',
    });
    await queryInterface.addIndex(
      'customerShopRoutingEvents',
      ['toShopAddressId'],
      { name: 'customer_shop_routing_events_to_shop' }
    );
    await queryInterface.addIndex(
      'customerShopRoutingEvents',
      ['fromShopAddressId'],
      { name: 'customer_shop_routing_events_from_shop' }
    );
    await queryInterface.addIndex('customerShopRoutingEvents', ['createdAt'], {
      name: 'customer_shop_routing_events_created_at',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'customerShopRoutingEvents')) {
      await queryInterface.dropTable('customerShopRoutingEvents');
    }
  },
};

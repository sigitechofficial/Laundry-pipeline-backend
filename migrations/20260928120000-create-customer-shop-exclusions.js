'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/**
 * Admin can exclude a customer from a specific shop so marketplace routing
 * (preferred + broadcast + shop accept) skips that shop for that customer.
 * Admin manual assign still works (ops override).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, 'customerShopExclusions')) return;

    await queryInterface.createTable('customerShopExclusions', {
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
      reason: {
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
      createdAt: { allowNull: false, type: Sequelize.DATE },
      updatedAt: { allowNull: false, type: Sequelize.DATE },
    });

    await queryInterface.addIndex(
      'customerShopExclusions',
      ['customerId', 'shopAddressId'],
      {
        unique: true,
        name: 'customer_shop_exclusions_customer_shop_unique',
      }
    );
    await queryInterface.addIndex('customerShopExclusions', ['shopAddressId'], {
      name: 'customer_shop_exclusions_shop_address_id',
    });
    await queryInterface.addIndex('customerShopExclusions', ['customerId'], {
      name: 'customer_shop_exclusions_customer_id',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'customerShopExclusions')) {
      await queryInterface.dropTable('customerShopExclusions');
    }
  },
};

'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class customerShopRoutingEvent extends Model {
    static associate(models) {
      customerShopRoutingEvent.belongsTo(models.users, {
        foreignKey: 'customerId',
        as: 'customer',
      });
      customerShopRoutingEvent.belongsTo(models.users, {
        foreignKey: 'adminId',
        as: 'admin',
      });
      customerShopRoutingEvent.belongsTo(models.addressDb, {
        foreignKey: 'fromShopAddressId',
        as: 'fromShop',
      });
      customerShopRoutingEvent.belongsTo(models.addressDb, {
        foreignKey: 'toShopAddressId',
        as: 'toShop',
      });
      customerShopRoutingEvent.belongsTo(models.addressDb, {
        foreignKey: 'sourceShopAddressId',
        as: 'sourceShop',
      });
    }
  }

  customerShopRoutingEvent.init(
    {
      customerId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      action: {
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      fromShopAddressId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      toShopAddressId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      sourceShopAddressId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      wasReturningAtFromShop: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
      },
      wasReturningAtToShop: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
      },
      adminId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      note: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'customerShopRoutingEvent',
      tableName: 'customerShopRoutingEvents',
    }
  );

  return customerShopRoutingEvent;
};

'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class bookingShopAssignmentEvent extends Model {
    static associate(models) {
      bookingShopAssignmentEvent.belongsTo(models.booking, {
        foreignKey: 'bookingId',
      });
      bookingShopAssignmentEvent.belongsTo(models.addressDb, {
        foreignKey: 'fromShopId',
        as: 'fromShop',
      });
      bookingShopAssignmentEvent.belongsTo(models.addressDb, {
        foreignKey: 'toShopId',
        as: 'toShop',
      });
      bookingShopAssignmentEvent.belongsTo(models.users, {
        foreignKey: 'actedByUserId',
        as: 'actedByUser',
      });
    }
  }

  bookingShopAssignmentEvent.init(
    {
      bookingId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      fromShopId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      toShopId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      actedByUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      source: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'admin',
      },
      note: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'bookingShopAssignmentEvent',
      tableName: 'bookingShopAssignmentEvents',
    }
  );

  return bookingShopAssignmentEvent;
};

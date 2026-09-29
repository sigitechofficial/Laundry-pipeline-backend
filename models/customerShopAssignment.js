'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class customerShopAssignment extends Model {
    static associate(models) {
      customerShopAssignment.belongsTo(models.users, {
        foreignKey: 'customerId',
        as: 'customer',
      });
      customerShopAssignment.belongsTo(models.users, {
        foreignKey: 'shopUserId',
        as: 'shopOwner',
      });
      customerShopAssignment.belongsTo(models.addressDb, {
        foreignKey: 'shopAddressId',
        as: 'shopAddress',
      });
      customerShopAssignment.belongsTo(models.addressDb, {
        foreignKey: 'sourceShopAddressId',
        as: 'sourceShopAddress',
      });
      customerShopAssignment.belongsTo(models.users, {
        foreignKey: 'createdByAdminId',
        as: 'createdByAdmin',
      });
      customerShopAssignment.belongsTo(models.users, {
        foreignKey: 'unlinkedByAdminId',
        as: 'unlinkedByAdmin',
      });
    }
  }

  customerShopAssignment.init(
    {
      customerId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      shopAddressId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      shopUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      sourceShopAddressId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'active',
      },
      note: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      createdByAdminId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      unlinkedByAdminId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      unlinkedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'customerShopAssignment',
      tableName: 'customerShopAssignments',
    }
  );

  return customerShopAssignment;
};

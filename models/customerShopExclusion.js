'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class customerShopExclusion extends Model {
    static associate(models) {
      customerShopExclusion.belongsTo(models.users, {
        foreignKey: 'customerId',
        as: 'customer',
      });
      customerShopExclusion.belongsTo(models.users, {
        foreignKey: 'shopUserId',
        as: 'shopOwner',
      });
      customerShopExclusion.belongsTo(models.addressDb, {
        foreignKey: 'shopAddressId',
        as: 'shopAddress',
      });
      customerShopExclusion.belongsTo(models.users, {
        foreignKey: 'createdByAdminId',
        as: 'createdByAdmin',
      });
    }
  }

  customerShopExclusion.init(
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
      reason: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      createdByAdminId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'customerShopExclusion',
      tableName: 'customerShopExclusions',
    }
  );

  return customerShopExclusion;
};

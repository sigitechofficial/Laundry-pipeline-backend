'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class customerSelectedServiceRepairImage extends Model {
    static associate(models) {
      customerSelectedServiceRepairImage.belongsTo(models.customerSelectedService, {
        foreignKey: 'customerSelectedServiceId',
        as: 'selectedService',
      });
      customerSelectedServiceRepairImage.belongsTo(models.customerSelectedServiceLine, {
        foreignKey: 'customerSelectedServiceLineId',
        as: 'serviceLine',
      });
    }
  }

  customerSelectedServiceRepairImage.init(
    {
      customerSelectedServiceId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      customerSelectedServiceLineId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      imageUrl: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
    },
    {
      sequelize,
      modelName: 'customerSelectedServiceRepairImage',
      tableName: 'customerSelectedServiceRepairImages',
    }
  );

  return customerSelectedServiceRepairImage;
};

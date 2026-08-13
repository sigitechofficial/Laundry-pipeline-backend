'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class customerSelectedRepairItem extends Model {
    static associate(models) {
      customerSelectedRepairItem.belongsTo(models.booking, {
        foreignKey: 'bookingId',
        as: 'booking',
      });
      customerSelectedRepairItem.belongsTo(models.customerSelectedService, {
        foreignKey: 'customerSelectedServiceId',
        as: 'selectedService',
      });
      customerSelectedRepairItem.belongsTo(models.repairGarment, {
        foreignKey: 'repairGarmentId',
        as: 'garment',
      });
      customerSelectedRepairItem.hasMany(models.customerSelectedRepairItemOption, {
        foreignKey: 'customerSelectedRepairItemId',
        as: 'options',
      });
      customerSelectedRepairItem.hasMany(models.customerSelectedRepairItemImage, {
        foreignKey: 'customerSelectedRepairItemId',
        as: 'images',
      });
    }
  }

  customerSelectedRepairItem.init(
    {
      bookingId: { type: DataTypes.INTEGER, allowNull: false },
      customerSelectedServiceId: { type: DataTypes.INTEGER, allowNull: true },
      serviceId: { type: DataTypes.INTEGER, allowNull: false },
      repairGarmentId: { type: DataTypes.INTEGER, allowNull: false },
      garmentName: { type: DataTypes.STRING, allowNull: false },
      quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      instruction: { type: DataTypes.TEXT, allowNull: true },
    },
    {
      sequelize,
      modelName: 'customerSelectedRepairItem',
      tableName: 'customerSelectedRepairItems',
    }
  );

  return customerSelectedRepairItem;
};

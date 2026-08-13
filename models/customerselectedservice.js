'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class customerSelectedService extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      customerSelectedService.hasMany(models.customerSelectedServiceAddOn, {
        foreignKey: 'customerSelectedServiceId',
        as: 'addOns'
      });
      customerSelectedService.hasMany(models.customerSelectedServiceLine, {
        foreignKey: 'customerSelectedServiceId',
        as: 'serviceLines'
      });
      customerSelectedService.hasMany(models.bookingPreference, {
        foreignKey: 'customerSelectedServiceId',
        as: 'selectedServicePreferences'
      });
      customerSelectedService.hasMany(models.customerSelectedServiceRepairImage, {
        foreignKey: 'customerSelectedServiceId',
        as: 'repairImages'
      });
      customerSelectedService.hasMany(models.customerSelectedRepairItem, {
        foreignKey: 'customerSelectedServiceId',
        as: 'repairItems'
      });
    }
  }
  customerSelectedService.init({
    date: {
      type: DataTypes.DATE,
      allowNull: false
    },
    time: {
      type: DataTypes.TIME,
      allowNull: false
    },
    servicePrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true
    },
    categoryPrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true
    },
    items: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    bags: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Estimated bags for this service line when not using one shared bag',
    },
    status:{
      type:DataTypes.BOOLEAN,
      defaultValue:false
    },
    serviceInstruction: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'customerSelectedService',
  });
  return customerSelectedService;
};
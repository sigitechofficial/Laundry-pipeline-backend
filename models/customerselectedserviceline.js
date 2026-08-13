'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class customerSelectedServiceLine extends Model {
    static associate(models) {
      // Each line belongs to one selected service row (e.g. "Trousers x7").
      customerSelectedServiceLine.belongsTo(models.customerSelectedService, {
        foreignKey: 'customerSelectedServiceId',
        as: 'selectedService'
      });

      // A line holds its own add-ons (e.g. Line 1 = zip x2, patch x1).
      customerSelectedServiceLine.hasMany(models.customerSelectedServiceAddOn, {
        foreignKey: 'customerSelectedServiceLineId',
        as: 'addOns'
      });
      customerSelectedServiceLine.hasMany(models.customerSelectedServiceRepairImage, {
        foreignKey: 'customerSelectedServiceLineId',
        as: 'repairImages'
      });
    }
  }

  customerSelectedServiceLine.init({
    customerSelectedServiceId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    lineNum: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      comment: 'Line number within the service row (1-based)'
    },
    items: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      comment: 'Units in this line; sum of all lines === service.items'
    }
  }, {
    sequelize,
    modelName: 'customerSelectedServiceLine',
    tableName: 'customerSelectedServiceLines'
  });

  return customerSelectedServiceLine;
};

'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class customerSelectedServiceAddOn extends Model {
    static associate(models) {
      customerSelectedServiceAddOn.belongsTo(models.customerSelectedService, {
        foreignKey: 'customerSelectedServiceId',
        as: 'selectedService'
      });
      customerSelectedServiceAddOn.belongsTo(models.addOnServices, {
        foreignKey: 'addOnServiceId',
        as: 'addOnService'
      });
    }
  }

  customerSelectedServiceAddOn.init({
    customerSelectedServiceId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    addOnServiceId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'customerSelectedServiceAddOn',
  });

  return customerSelectedServiceAddOn;
};

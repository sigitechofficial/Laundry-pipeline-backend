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
      // The line (split group) this add-on belongs to.
      customerSelectedServiceAddOn.belongsTo(models.customerSelectedServiceLine, {
        foreignKey: 'customerSelectedServiceLineId',
        as: 'serviceLine'
      });
    }
  }

  customerSelectedServiceAddOn.init({
    customerSelectedServiceId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    customerSelectedServiceLineId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Line/group this add-on belongs to (null for legacy flat rows)'
    },
    addOnServiceId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      comment: 'Unit price snapshot'
    },
    items: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      comment: 'Quantity of this add-on on the line'
    },
    instructions: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Optional agent note for this add-on'
    }
  }, {
    sequelize,
    modelName: 'customerSelectedServiceAddOn',
  });

  return customerSelectedServiceAddOn;
};

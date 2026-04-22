'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class addOnServices extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      addOnServices.hasMany(models.customerSelectedServiceAddOn, {
        foreignKey: 'addOnServiceId',
        as: 'selectedServiceAddOns'
      });
    }
  }
  addOnServices.init({
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    price: {
      type: DataTypes.DECIMAL,
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'addOnServices',
    paranoid: true
  });
  return addOnServices;
};
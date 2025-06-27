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
      // define association here
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
    status:{
      type:DataTypes.BOOLEAN,
      allowNull:true
    }
  }, {
    sequelize,
    modelName: 'customerSelectedService',
  });
  return customerSelectedService;
};
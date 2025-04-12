'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class servicePreferences extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  servicePreferences.init({
    type:{
      type:DataTypes.ENUM('Mixed','White Separate','Dark Seprate','White + Light mixed'),
      allowNull:true
    },
    chooseTemperature: {
      type:DataTypes.ENUM('30 C','40 C','60 C','90 C'),
    allowNull:true
  },
  numberOfBags:{
    type:DataTypes.NUMBER,
    allowNull:false,
  }
  }, {
    sequelize,
    modelName: 'servicePreferences',
  });
  return servicePreferences;
};
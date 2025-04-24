'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class bussinessWorkingHours extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      
    }
  }
  bussinessWorkingHours.init({
    dayOfWeek: {
      type:DataTypes.ENUM('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'),
      allowNull:false,
    },
    openTime: {
      type:DataTypes.TIME,
    allowNull:true,
    defaultValue:'07:00:00'
  },
  closeTime: {
      type:DataTypes.TIME,
    allowNull:true,
    defaultValue:'19:00:00'
  },
  status:{
    type:DataTypes.BOOLEAN,
    allowNull:false,
    defaultValue:false
  }
  }, {
    sequelize,
    modelName: 'bussinessWorkingHours',
  });
  return bussinessWorkingHours;
};
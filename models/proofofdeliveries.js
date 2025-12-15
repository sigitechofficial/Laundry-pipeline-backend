'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class proofOfDeliveries extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  proofOfDeliveries.init({
    imgUpload: {
      type: DataTypes.STRING,
      allowNull: true
    },
    noOfItems: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    note: {
      type: DataTypes.STRING,
      allowNull: true
    },
    deliveryType:{
      type:DataTypes.ENUM('pickUp','dropOff'),
      allowNull:false
    }
  }, {
    sequelize,
    modelName: 'proofOfDeliveries',
  });
  return proofOfDeliveries;
};
'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class onHoldCustomerOption extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  onHoldCustomerOption.init({
    option: {
      type:DataTypes.STRING,
    allowNull:false
  },
    status: {
      type:DataTypes.BOOLEAN,
    defaultValue:false
  },
  title:{
    type:DataTypes.STRING(500),
    allowNull:true
  },
  conformationText:{
    type:DataTypes.STRING(500),
    allowNull:true
  },
  notConfirmText:{
    type:DataTypes.STRING(500),
    allowNull:true
  }
  }, {
    sequelize,
    modelName: 'onHoldCustomerOption',
    paranoid:true
  });
  return onHoldCustomerOption;
};
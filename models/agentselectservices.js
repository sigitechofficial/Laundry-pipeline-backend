'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class agentSelectServices extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
    }
  }
  agentSelectServices.init({
    status: {
      type:DataTypes.BOOLEAN,
      defaultValue:false
    },
    serviceTimeRequired:{
      type:DataTypes.ENUM('N/A','24 Hours','48 Hours','More Than 48 Hours'),
      allowNull:false
    }
  }, {
    sequelize,
    modelName: 'agentSelectServices',
    paranoid: true,
  });
  return agentSelectServices;
};
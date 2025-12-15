'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class machineCount extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  machineCount.init({
    total: {
      type:DataTypes.ENUM('0','1-2','3-5','5+'),
    allowNull:true
  },
    status: {
      type:DataTypes.BOOLEAN,
    defaultValue:false
  }
  }, {
    sequelize,
    modelName: 'machineCount',
  });
  return machineCount;
};
'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class driverInZones extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  driverInZones.init({
    status: {
      type:DataTypes.BOOLEAN,
    defaultValue:false
  }
  }, {
    sequelize,
    modelName: 'driverInZones',
  });
  return driverInZones;
};
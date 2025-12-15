'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class serviceWithPreferences extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      
    }
  }
  serviceWithPreferences.init({
    status: DataTypes.BOOLEAN
  }, {
    sequelize,
    modelName: 'serviceWithPreferences',
    paranoid:true
  });
  return serviceWithPreferences;
};
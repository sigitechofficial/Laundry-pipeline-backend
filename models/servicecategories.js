'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class serviceCategories extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  serviceCategories.init({
    status: DataTypes.BOOLEAN
  }, {
    sequelize,
    modelName: 'serviceCategories',
    paranoid:true
  });
  return serviceCategories;
};
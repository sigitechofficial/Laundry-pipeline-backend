'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class deviceToken extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  deviceToken.init({
    tokenId: {
      type:DataTypes.STRING,
    allowNull:true},
    status: {
      type:DataTypes.BOOLEAN,
      defaultValue:false}
  }, {
    sequelize,
    modelName: 'deviceToken',
    paranoid: true,
  });
  return deviceToken;
};
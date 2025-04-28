'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class appUnits extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  appUnits.init({
    status: {type:DataTypes.BOOLEAN,
      allowNull:true
    },
    deleted: {
      type:DataTypes.BOOLEAN,
      allowNull:true,
      defaultValue:false
    }
  }, {
    sequelize,
    modelName: 'appUnits',
    freezeTableName:true,
    tableName:'appUnits'
  });
  return appUnits;
};
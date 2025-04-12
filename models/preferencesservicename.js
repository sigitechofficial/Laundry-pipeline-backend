'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class preferencesServiceName extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      preferencesServiceName.hasMany(models.servicePreferences,{foreignKey:'preferencesServiceNameId'})
      models.servicePreferences.belongsTo(preferencesServiceName,{foreignKey:'preferencesServiceNameId'})
    }
  }
  preferencesServiceName.init({
    title:{
      type: DataTypes.STRING,
    allowNull:true
  },
    status: {
      type:DataTypes.BOOLEAN,
    defaultValue:true
  }
  }, {
    sequelize,
    modelName: 'preferencesServiceName',
  });
  return preferencesServiceName;
};
'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class preferenceValues extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Relation with bookingPreference Model
      preferenceValues.hasMany(models.bookingPreference)
      models.bookingPreference.belongsTo(preferenceValues)
    }
  }
  preferenceValues.init({
    value:{
      type: DataTypes.STRING,
      allowNull:false
    },
    status:{
      type: DataTypes.BOOLEAN,
      allowNull:false,
      defaultValue:1
    }
  }, {
    sequelize,
    modelName: 'preferenceValues',
    paranoid:true
  });
  return preferenceValues;
};
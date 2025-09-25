'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class preferenceTypes extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      
      //Relation with Model serviceWithPreferences
      preferenceTypes.hasMany(models.serviceWithPreferences)
      models.serviceWithPreferences.belongsTo(preferenceTypes)


      preferenceTypes.hasMany(models.preferenceValues)
      models.preferenceValues.belongsTo(preferenceTypes)

      //Relation with bookingPreference Model
      preferenceTypes.hasMany(models.bookingPreference)
      models.bookingPreference.belongsTo(preferenceTypes)
    }
  }
  preferenceTypes.init({
    name: { 
      type: DataTypes.STRING, 
      allowNull: false 
    },
    status: { 
      type: DataTypes.BOOLEAN, 
      allowNull: false, 
      defaultValue: 1 
    }
  }, {
    sequelize,
    modelName: 'preferenceTypes',
    paranoid:true
  });

  return preferenceTypes;
};
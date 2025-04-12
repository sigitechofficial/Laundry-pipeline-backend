'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class cities extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Relation with model Zone
      cities.hasOne(models.zone)
      models.zone.belongsTo(cities)

      //Relation with Model Users
      cities.hasOne(models.users)
      models.users.belongsTo(cities)

      //Relation with model driverInZones
      cities.hasMany(models.driverInZones)
      models.driverInZones.belongsTo(cities)

      //Relation with Address Model
      cities.hasOne(models.addressDb)
      models.addressDb.belongsTo(cities)

    }
  }
  cities.init({
    name: {
      type:DataTypes.STRING,
    allowNull:false
  },
    lat: {
      type:DataTypes.STRING,
    allowNull:false
  },
    lng: {
      type:DataTypes.STRING,
     allowNull:false},
    status: {
      type:DataTypes.BOOLEAN,
    allowNull:true,
  }
  }, {
    sequelize,
    modelName: 'cities',
  });
  return cities;
};
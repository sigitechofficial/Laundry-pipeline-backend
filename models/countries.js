'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class countries extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Realtion with model Cities
      countries.hasMany(models.cities)
      models.cities.belongsTo(countries)

      //Relation with model Users
      countries.hasOne(models.users)
      models.users.belongsTo(countries)

      //Relation with model driverInZones
      countries.hasOne(models.driverInZones)
      models.driverInZones.belongsTo(countries)
      
      //Relation with AddressDb
      countries.hasMany(models.addressDb)
      models.addressDb.belongsTo(countries)
    }
  }
  countries.init({
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    shortName: {
      type: DataTypes.STRING,
      allowNull: false
    },
    image: {
      type: DataTypes.STRING,
      allowNull: true
    },
    status: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'countries',
  });
  return countries;
};
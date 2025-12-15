'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class zone extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Relation with Model AddressDb
      zone.hasMany(models.addressDb)
      models.addressDb.belongsTo(zone)

      //Realltion with driverInZones Model
      zone.hasMany(models.driverInZones)
      models.driverInZones.belongsTo(zone)

      //Relation with users Table
      // zone.hasMany(models.users)
      // models.users.belongsTo(zone)

      //Relation with the Booking Table
      zone.hasMany(models.booking)
      models.booking.belongsTo(zone)
    }
  }
  zone.init({
    name: {
      type:DataTypes.STRING,
    allowNull:false
  },
    coordinates: DataTypes.GEOMETRY('POLYGON'),
    status: {
      type:DataTypes.BOOLEAN,
    defaultValue:false
  },
  zoneMinimumAmount:{
    type:DataTypes.DECIMAL(5,2),
    allowNull:true
  },
  zoneAdminComission:{
    type:DataTypes.INTEGER,
    allowNull:true
  },
  serviceCharge:{
    type:DataTypes.FLOAT,
    allowNull:true
  },
  paymentMehtod:{
    type:DataTypes.ENUM('Cash','Stripe','Paypal'),
    allowNull:true,
    defaultValue: 'Cash'
  }
  }, {
    sequelize,
    modelName: 'zone',
    paranoid:true
  });
  return zone;
};
'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class addressDb extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Rrealtion with Model Booking As pickupAddress
      addressDb.hasMany(models.booking,{as:'pickupAddress',foreignKey:'pickupAddresId'})
      models.booking.belongsTo(addressDb,{as:'pickupAddress',foreignKey:'pickupAddresId'})
      //Relation with Model Booking as DropOffAddress
      addressDb.hasMany(models.booking,{as:'dropOffAddress',foreignKey:'dropOffAddressId'})
      models.booking.belongsTo(addressDb,{as:'dropOffAddress',foreignKey:'dropOffAddressId'})
      //Relation with Booking as shopAddressId
      addressDb.hasMany(models.booking,{as:'laundryShop',foreignKey:'laundryShopId'})
      models.booking.belongsTo(addressDb,{as:'laundryShop',foreignKey:'laundryShopId'})

      //Relation with bussinessInformation  Model
      addressDb.hasMany(models.bussinessInformation,{foreignKey:'shopAddressId'})
      models.bussinessInformation.belongsTo(addressDb,{foreignKey:'shopAddressId'})
    }
  }
  addressDb.init({
    title: {
      type: DataTypes.ENUM('Office','Home','Other','Hotel'),
      allowNull:true,
    },
    customAddressTitle:{
      type:DataTypes.STRING(40),
      allowNull:true,
    },
    hotelName:{
      type:DataTypes.STRING,
      allowNull:true
    },
    apartmentNumber:{
      type:DataTypes.INTEGER,
      allowNull:true
    },
    floor:{
      type:DataTypes.INTEGER,
      allowNull:true,
    },
    streetAddress: {
      type: DataTypes.STRING,
      allowNull:false,
    },
    district: {
      type: DataTypes.STRING,
      allowNull:true,
    },
    province: {
      type: DataTypes.STRING,
      allowNull:true
    },
    postalcode: {
      type: DataTypes.STRING,
      allowNull:true,
    },
    lat: {
      type: DataTypes.STRING,
      allowNull:false,
    },
    lng: {
      type: DataTypes.STRING,
      allowNull:false
    },
    status: {
      type: DataTypes.BOOLEAN,
      defaultValue:1
    },
    radius:{
      type:DataTypes.DECIMAL,
      allowNull:true
    },
    addressType:{
      type:DataTypes.ENUM('dropOff','pickUp','LaundaryShopAddress'),
      allowNull:true
    },
    coordinates:{
      type:DataTypes.GEOMETRY('POLYGON'),
      allowNull:true
    },
    isDefault:{
      type:DataTypes.BOOLEAN,
      defaultValue:false
    },
    createdAt: {
      allowNull: false,
      type: DataTypes.DATE
    },
    updatedAt: {
      allowNull: false,
      type: DataTypes.DATE
    },
  }, {
    sequelize,
    modelName: 'addressDb',
    paranoid: true, // Enable soft delete with deletedAt
  });
  return addressDb;
};
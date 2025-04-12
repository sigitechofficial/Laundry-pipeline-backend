'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class vehicleType extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {

      //Realtion with driver Detail Model
      vehicleType.hasMany(models.driverDetail);
      models.driverDetail.belongsTo(vehicleType);

      vehicleType.hasOne(models.booking)
      models.booking.belongsTo(vehicleType)
    }
  }
  vehicleType.init({
    title:{
      type: DataTypes.STRING(),
      allowNull: true,
      defaultValue: ''
  },
    image:{
      type: DataTypes.STRING(),
      allowNull: true,
      defaultValue: ''
  },
    status: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
  },
    baseRate: {
      type: DataTypes.FLOAT(8,2),
      defaultValue: '0.00',
  },
    perUnitRate: {
      type: DataTypes.FLOAT(8,2),
      defaultValue: '0.00',
  },
    perRideCharge: {
      type: DataTypes.FLOAT(8,2),
      defaultValue: '0.00',
  },
    weightCapacity: {
      type: DataTypes.FLOAT(8,2),
      defaultValue: '0.00',
  },
    volumeCapacity: {
      type: DataTypes.FLOAT(8,2),
      defaultValue: '0.00',
  }
  }, {
    sequelize,
    modelName: 'vehicleType',
  });
  return vehicleType;
};
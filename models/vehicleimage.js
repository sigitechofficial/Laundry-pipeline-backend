'use strict';
const {
  Model
} = require('sequelize');
const driverdetail = require('./driverdetail');
module.exports = (sequelize, DataTypes) => {
  class vehicleImage extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
    }
  }
  vehicleImage.init({
    image: {
      type: DataTypes.STRING(),
      allowNull: true,
      defaultValue: ''
  },
    uploadTime: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: sequelize.literal("CURRENT_TIMESTAMP")
  },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: true
  }
  }, {
    sequelize,
    modelName: 'vehicleImage',
  });
  return vehicleImage;
};
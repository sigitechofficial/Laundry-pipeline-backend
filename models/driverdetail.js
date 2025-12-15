'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class driverDetail extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      driverDetail.hasOne(models.vehicleImage);
      models.vehicleImage.belongsTo(driverDetail);
    }
  }
  driverDetail.init({
    approvedByAdmin:{
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false
  },
    licIssueDate:{
      type: DataTypes.DATEONLY,
      allowNull: true,
  },
    licExpiryDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
  },
    licFrontImage: {
      type: DataTypes.STRING(),
      allowNull: true,
      defaultValue: ''
  },
    licBackImage: {
      type: DataTypes.STRING(),
      allowNull: true,
      defaultValue: ''
  },
    vehicleName: {
      type: DataTypes.STRING(),
      allowNull: true,
      defaultValue: ''
  },
    vehicleModel: {
      type: DataTypes.STRING(),
      allowNull: true,
      defaultValue: ''
  },
    vehicleYear: {
      type: DataTypes.STRING(),
      allowNull: true,
      defaultValue: ''
  },
    vehicleColour:{
      type: DataTypes.STRING(),
      allowNull: true,
      defaultValue: ''
  }
  }, {
    sequelize,
    modelName: 'driverDetail',
  });
  return driverDetail;
};
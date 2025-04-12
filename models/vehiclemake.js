'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class vehicleMake extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      vehicleMake.hasMany(models.vehicleModel);
      models.vehicleModel.belongsTo(vehicleMake);
    }
  }
  vehicleMake.init({
    name: {
      type: DataTypes.STRING(),
      allowNull: true,
      defaultValue: ''
  },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false
  },
    deleted:{
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false
  }
  }, {
    sequelize,
    modelName: 'vehicleMake',
  });
  return vehicleMake;
};
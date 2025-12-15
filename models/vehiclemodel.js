'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class vehicleModel extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  vehicleModel.init({
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
    deleted: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false
  }
  }, {
    sequelize,
    modelName: 'vehicleModel',
  });
  return vehicleModel;
};
'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class machines extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Realtion with Model machine Count
      machines.hasMany(models.machineCount,{foreignKey:'machineId'})
      models.machineCount.belongsTo(machines,{foreignKey:'machineId'})
    }
  }
  machines.init({
    name: {
      type:DataTypes.STRING,
    allowNull:false
  },
    status: {
      type:DataTypes.BOOLEAN,
    allowNull:false
  }
  }, {
    sequelize,
    modelName: 'machines',
  });
  return machines;
};
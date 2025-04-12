'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class features extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Relation with model Permissions
      features.hasMany(models.permissions)
      models.permissions.belongsTo(features)
    }
  }
  features.init({
    title: {
      type:DataTypes.STRING,
      allowNull:false,
      defaultValue:null,
    },
    status: {
      type:DataTypes.BOOLEAN,
      defaultValue:false,
    },
    featureOf: {
      type:DataTypes.ENUM('Admin','Agent','both','Agent Employee'),
      allowNull:false,
    },
    key:{
      type:DataTypes.STRING(60),
      allowNull:false,
    }
  }, {
    sequelize,
    modelName: 'features',
  });
  return features;
};
'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class permissions extends Model {
    static associate(models) {
    }
  }
  permissions.init({
    featureId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    roleId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    create: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    read: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    update: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    delete: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  }, {
    sequelize,
    modelName: 'permissions',
  });
  return permissions;
};

'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class roles extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // Relation with Model Permissions
      roles.hasMany(models.permissions)
      models.permissions.belongsTo(roles)

      // Relation with Model users
      roles.hasMany(models.users)
      models.users.belongsTo(roles)
    }
  }
  roles.init({
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
    modelName: 'roles',
  });
  return roles;
};
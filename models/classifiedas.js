'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class classifiedAs extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Realtion with Model Users
      classifiedAs.hasMany(models.users,{foreignKey:'classifiedAsId'})
      models.users.belongsTo(classifiedAs,{foreignKey:'classifiedAsId'})
    }
  }
  classifiedAs.init({
    name: {
      type:DataTypes.STRING,
    allowNull:false
  }
  }, {
    sequelize,
    modelName: 'classifiedAs',
  });
  return classifiedAs;
};
'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class unAcknowledgedEvents extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  unAcknowledgedEvents.init({
    to:{
      type: DataTypes.STRING,
      allowNull:true
    },
    event: {
      type:DataTypes.STRING,
      allowNull:true
    },
    data: {
      type:DataTypes.TEXT,
      allowNull:true
    },
    bookingId: {
      type:DataTypes.INTEGER,
      allowNull:true
    }
  }, {
    sequelize,
    modelName: 'unAcknowledgedEvents',
  });
  return unAcknowledgedEvents;
};
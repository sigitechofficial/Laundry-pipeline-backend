'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class bookingHistory extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  bookingHistory.init({
    date: {
      type:DataTypes.DATEONLY,
    allowNull:false
  },
    time: {
      type:DataTypes.TIME,
    allowNull:false
  }
  }, {
    sequelize,
    modelName: 'bookingHistory',
  });
  return bookingHistory;
};
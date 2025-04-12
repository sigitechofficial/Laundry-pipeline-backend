'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class bookingStatus extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {

      //Relation with Booking Model
      bookingStatus.hasOne(models.booking)
      models.booking.belongsTo(bookingStatus)
      // Relation with BookingStatus Model
      bookingStatus.hasOne(models.bookingHistory)
      models.bookingHistory.belongsTo(bookingStatus)
    }
  }
  bookingStatus.init({
    title: {type:DataTypes.STRING,
      allowNull:true,
    },
    description: {type:DataTypes.STRING,
      allowNull:true
    }
  }, {
    sequelize,
    modelName: 'bookingStatus',
  });
  return bookingStatus;
};
'use strict';
const { Model } = require('sequelize');

/**
 * One row per reschedule of a booking. Courtesy ("free reschedules in N days") counts these rows,
 * so it counts reschedules, not orders. A reschedule caused by a late driver is logged but never
 * uses up a courtesy reschedule.
 */
module.exports = (sequelize, DataTypes) => {
  class bookingReschedule extends Model {
    static associate(models) {
      bookingReschedule.belongsTo(models.booking, { foreignKey: 'bookingId', as: 'booking' });
    }
  }
  bookingReschedule.init({
    bookingId: { type: DataTypes.INTEGER, allowNull: false },
    customerId: { type: DataTypes.INTEGER, allowNull: false },
    // 'pickup' = before collection, 'delivery' = after collection; null for rows copied from older data.
    phase: { type: DataTypes.STRING(16), allowNull: true },
    charge: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    driverLate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, {
    sequelize,
    modelName: 'bookingReschedule',
    tableName: 'booking_reschedules',
  });
  return bookingReschedule;
};

'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class bookingPreference extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      bookingPreference.belongsTo(models.booking, {
        foreignKey: 'bookingId',
        as: 'booking'
      });
      bookingPreference.belongsTo(models.customerSelectedService, {
        foreignKey: 'customerSelectedServiceId',
        as: 'selectedService'
      });
    }
  }
  bookingPreference.init({
    bookingId: DataTypes.INTEGER,
    customerSelectedServiceId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null
    },
    preferenceTypeId: DataTypes.INTEGER,
    preferenceValueId: DataTypes.INTEGER,
    parentPreferenceValueId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null
    },
    preferenceInstruction: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE
  }, {
    sequelize,
    modelName: 'bookingPreference',
  });
  return bookingPreference;
};
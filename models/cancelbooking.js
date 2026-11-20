'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class cancelBooking extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  cancelBooking.init({
    reasonText:{
      type: DataTypes.STRING,
    allowNull:false
  },
    // The cancellation fee and what happened to it (migration 20261121130000).
    feeAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    feeCurrency: { type: DataTypes.STRING(10), allowNull: true },
    // none | retained (kept from the prepaid amount) | charged (card charged) | owed (not collected)
    feeStatus: { type: DataTypes.STRING(16), allowNull: true },
    feeOwed: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    feeError: { type: DataTypes.STRING(500), allowNull: true },
  }, {
    sequelize,
    modelName: 'cancelBooking',
  });
  return cancelBooking;
};
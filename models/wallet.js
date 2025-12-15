'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class wallet extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  wallet.init({
    amount: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
      defaultValue: '0.00'
  },
    currency: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: '$'
  },
    description: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: ''
  },
    type: {
      type: DataTypes.ENUM('credit', 'debit'),
      allowNull: false,
      defaultValue: 'credit'
  },
    status: {
      type: DataTypes.ENUM('pending', 'completed', 'failed'),
      allowNull: false,
      defaultValue: 'completed'
  }
  }, {
    sequelize,
    modelName: 'wallet',
  });
  return wallet;
};
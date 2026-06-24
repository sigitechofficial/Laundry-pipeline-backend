'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class wallet extends Model {
    static associate(models) {
      wallet.belongsTo(models.users, { foreignKey: 'userId', as: 'user' });
      wallet.belongsTo(models.booking, { foreignKey: 'bookingId', as: 'booking' });
    }
  }
  wallet.init({
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    bookingId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    referenceType: {
      type: DataTypes.STRING(64),
      allowNull: true,
      defaultValue: '',
    },
    amount: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
      defaultValue: '0.00'
    },
    currency: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'GBP'
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
    tableName: 'wallets',
    paranoid: true,
  });
  return wallet;
};

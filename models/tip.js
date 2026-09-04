'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class tip extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      tip.belongsTo(models.booking, {
        foreignKey: 'bookingId',
        as: 'booking'
      });
    }
  }
  tip.init({
    bookingId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'bookings',
        key: 'id'
      }
    },
    amount: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true
    },
    source: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'booking',
    },
    paymentType: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
    stripePaymentIntentId: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    paidAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdByUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  }, {
    sequelize,
    modelName: 'tip',
    tableName: 'tips',
  });
  return tip;
};
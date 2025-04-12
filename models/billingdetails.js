'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class billingDetails extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  billingDetails.init({
    upfrontAmount: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
  },
    discount: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
  },
    total: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
  },
    serviceCharge: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
  },
    categoryCharge: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: true,
    },
    pickupDriverEarning: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
  },
    deliveryDriverEarning: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
  },
  paymentStatus:{
    type:DataTypes.ENUM('Paid','Pending','Failed'),
    defaultValue:'Pending'
  }
  }, {
    sequelize,
    modelName: 'billingDetails',
  });
  return billingDetails;
};
'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class otpVerification extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  otpVerification.init({
    OTP:{
      type: DataTypes.STRING(5),
      allowNull: true,
  },
    reqAt: {
      type: DataTypes.DATE,
      allowNull: true,
  },
    expirtAt: {
      type: DataTypes.DATE,
      allowNull: true,
  },
    verifiedAtForgetCase: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
  }
  }, {
    sequelize,
    modelName: 'otpVerification',
  });
  return otpVerification;
};
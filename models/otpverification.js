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
  },
    // Wrong guesses at the current code (services/shared/passwordReset.js).
    failedAttempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
  },
    // End of the window to set a new password after the reset code was verified
    // (services/shared/passwordReset.js); expirtAt stays the code's own expiry.
    resetExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
  },
    // What the current code was issued for: 'signup' or 'password_reset'
    // (services/shared/otpCode.js CODE_PURPOSES); NULL verifies nothing.
    codePurpose: {
      type: DataTypes.STRING(32),
      allowNull: true,
      validate: { isIn: [['signup', 'password_reset']] },
  }
  }, {
    sequelize,
    modelName: 'otpVerification',
    paranoid: true,
  });
  return otpVerification;
};
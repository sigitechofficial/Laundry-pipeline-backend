'use strict';

/** Shared pieces of the email + OTP sign-up flow (customer and agent). */

const otpMail = require('../../helper/otpMail');
const { newOtpCode } = require('./otpCode');

/** Real dependencies for services/shared/signupAccountPersistence.js. */
function signupPersistenceDeps() {
  const db = require('../../models');
  return {
    sequelize: db.sequelize,
    users: db.users,
    otpVerification: db.otpVerification,
    deviceToken: db.deviceToken,
  };
}

/** The sign-up code: an account code (services/shared/otpCode.js). */
function newSignupOtp(now = new Date()) {
  return newOtpCode(now);
}

/** Call only after the sign-up transaction committed; a mail failure must not undo the sign-up. */
async function sendSignupOtpEmail({ email, otpCode, userName }) {
  try {
    await otpMail({ type: 'RegisterOTP', email, OTP: otpCode, userName });
  } catch (mailError) {
    console.error('⚠️ OTP email failed (non-blocking):', mailError.message || mailError);
  }
}

module.exports = { signupPersistenceDeps, newSignupOtp, sendSignupOtpEmail };

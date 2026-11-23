'use strict';

/** Shared pieces of the email + OTP sign-up flow (customer and agent). */

const otpGenerator = require('otp-generator');
const otpMail = require('../../helper/otpMail');

const SIGNUP_OTP_TTL_MS = 1 * 60 * 1000;

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

/** 4-digit OTP valid for 1 minute. */
function newSignupOtp(now = new Date()) {
  return {
    code: otpGenerator.generate(4, { lowerCaseAlphabets: false, upperCaseAlphabets: false, specialChars: false }),
    requestedAt: now,
    expiresAt: new Date(now.getTime() + SIGNUP_OTP_TTL_MS),
  };
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

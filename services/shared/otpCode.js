'use strict';

/**
 * The emailed one-time code of an account (one otpVerifications row per account): its format,
 * its lifetime and the row state every new code starts with. The single definition used by
 * sign-up (services/shared/signupSupport.js, signupAccountPersistence.js), resend and password
 * reset (services/shared/passwordReset.js) for customers, shop agents and drivers.
 *
 * FORMAT — the apps' code fields take OTP_CODE_LENGTH digits only, so a code is digits only
 * (otp-generator with specialChars left on produced codes such as "4#1!" nobody could type).
 * Every value 0000-9999 is possible; a code with a leading zero is a string ("0421").
 */

const crypto = require('crypto');

/** Digits in a code; the customer and agent apps' code fields have this many boxes. */
const OTP_CODE_LENGTH = 4;

/** How long a newly issued code can be entered: the platform's existing 1 minute. */
const OTP_TTL_MS = 1 * 60 * 1000;

/** A uniformly random code of OTP_CODE_LENGTH digits, from the CSPRNG. */
function generateOtpCode() {
  return String(crypto.randomInt(0, 10 ** OTP_CODE_LENGTH)).padStart(OTP_CODE_LENGTH, '0');
}

/** A new code and its validity window. */
function newOtpCode(now = new Date()) {
  return {
    code: generateOtpCode(),
    requestedAt: now,
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
  };
}

/**
 * Columns of the account's otpVerifications row for a newly issued code: the code replaces
 * any earlier one, and the earlier code's lifecycle (wrong guesses, a verified reset) ends.
 */
function freshCodeColumns(otp) {
  return {
    OTP: otp.code,
    reqAt: otp.requestedAt,
    expirtAt: otp.expiresAt,
    failedAttempts: 0,
    verifiedAtForgetCase: false,
  };
}

/**
 * A code as the client sent it, as the string stored in the row. JSON clients that send the
 * code as a number lose its leading zeros (421 for "0421"); they are restored here.
 */
function normalizeSubmittedCode(code) {
  if (typeof code === 'number' && Number.isInteger(code) && code >= 0) {
    return String(code).padStart(OTP_CODE_LENGTH, '0');
  }
  if (typeof code === 'string') return code.trim();
  return '';
}

module.exports = {
  OTP_CODE_LENGTH,
  OTP_TTL_MS,
  generateOtpCode,
  newOtpCode,
  freshCodeColumns,
  normalizeSubmittedCode,
};

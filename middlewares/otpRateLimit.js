'use strict';

/**
 * Per-IP limits on the unauthenticated emailed-code endpoints (customer, agent, driver):
 * requesting a code (forget password, resend), verifying one, and setting the new password.
 *
 * They complement the per-account limits of services/shared/passwordReset.js (codes issued per
 * account, wrong guesses per code): those bound guessing at one account, these bound one client
 * working through many accounts. `trust proxy` is set in laundary.js, so req.ip is the client.
 * Refusals go through the universal error handler (429, the usual { status: "0", message,
 * error, data: { retryAfterSeconds } } body).
 */

const rateLimitLib = require('express-rate-limit');
const { TooManyRequestsError } = require('./universalErrorHandler');

const rateLimit = rateLimitLib.rateLimit || rateLimitLib;
const WINDOW_MS = 15 * 60 * 1000;

const LIMITS = Object.freeze({
  issue: { max: 20, message: 'Too many OTP requests. Please wait and try again' },
  verify: { max: 30, message: 'Too many OTP attempts. Please wait and try again' },
  reset: { max: 20, message: 'Too many password reset attempts. Please wait and try again' },
});

function otpIpLimit({ max, message }) {
  return rateLimit({
    windowMs: WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
      const resetTime = req.rateLimit && req.rateLimit.resetTime;
      const retryAfterSeconds = resetTime
        ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
        : WINDOW_MS / 1000;
      next(new TooManyRequestsError(message, { retryAfterSeconds }));
    },
  });
}

module.exports = {
  OTP_IP_WINDOW_MS: WINDOW_MS,
  OTP_IP_LIMITS: LIMITS,
  otpIssueIpLimit: otpIpLimit(LIMITS.issue),
  otpVerifyIpLimit: otpIpLimit(LIMITS.verify),
  passwordResetIpLimit: otpIpLimit(LIMITS.reset),
};

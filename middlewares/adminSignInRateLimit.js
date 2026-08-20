'use strict';

const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib;

const ADMIN_SIGNIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_SIGNIN_MAX = 10;

const adminSignInRateLimit = rateLimit({
  windowMs: ADMIN_SIGNIN_WINDOW_MS,
  max: ADMIN_SIGNIN_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: '0',
    message: 'Too many sign-in attempts. Try again in 15 minutes.',
    data: {},
  },
});

adminSignInRateLimit.ADMIN_SIGNIN_WINDOW_MS = ADMIN_SIGNIN_WINDOW_MS;
adminSignInRateLimit.ADMIN_SIGNIN_MAX = ADMIN_SIGNIN_MAX;

module.exports = adminSignInRateLimit;

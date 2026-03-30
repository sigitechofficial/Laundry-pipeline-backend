/**
 * Email Templates Module
 * Central export for all email templates
 */

const generateOtpTemplate = require('./templates/otpVerification');
const generateSignupWelcomeTemplate = require('./templates/signupWelcome');
const generateForgotPasswordTemplate = require('./templates/forgotPassword');
const generateFooter = require('./partials/footer');

module.exports = {
  generateOtpTemplate,
  generateSignupWelcomeTemplate,
  generateForgotPasswordTemplate,
  generateFooter,
};

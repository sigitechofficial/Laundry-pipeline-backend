/**
 * Email Templates Module
 * Central export for all email templates
 */

const generateOtpTemplate = require('./templates/otpVerification');
const generateSignupWelcomeTemplate = require('./templates/signupWelcome');
const generateFooter = require('./partials/footer');

module.exports = {
  generateOtpTemplate,
  generateSignupWelcomeTemplate,
  generateFooter,
};

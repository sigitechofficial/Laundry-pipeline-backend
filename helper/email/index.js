/**
 * Email Templates Module
 * Central export for all email templates
 */

const generateOtpTemplate = require('./templates/otpVerification');
const generateFooter = require('./partials/footer');

module.exports = {
  generateOtpTemplate,
  generateFooter,
};

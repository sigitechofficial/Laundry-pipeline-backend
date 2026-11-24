'use strict';

const { DataTypes } = require('sequelize');
const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/**
 * otpVerifications.resetExpiresAt: until when a verified password-reset code allows the new
 * password to be set (services/shared/passwordReset.js PASSWORD_RESET_WINDOW_MS). It is separate
 * from expirtAt, which stays the emailed code's own expiry. NULL: no reset is open; a row
 * verified before this column existed must be verified again.
 */
module.exports = {
  async up(queryInterface) {
    await addColumnIfMissing(queryInterface, 'otpVerifications', 'resetExpiresAt', {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
      comment: 'End of the window to set a new password after the reset code was verified',
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'otpVerifications', 'resetExpiresAt');
  },
};

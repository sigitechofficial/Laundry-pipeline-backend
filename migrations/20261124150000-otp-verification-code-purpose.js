'use strict';

const { DataTypes } = require('sequelize');
const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/**
 * otpVerifications.codePurpose: what the account's current code was issued for, 'signup' or
 * 'password_reset' (services/shared/otpCode.js CODE_PURPOSES). A code verifies only through the
 * flow of its purpose (services/shared/passwordReset.js).
 *
 * Production: a nullable column with no default is added to existing rows as NULL without a
 * table rewrite of their data, and no row is updated. NULL means "issued before purposes were
 * recorded": such a code verifies nothing. Codes live 1 minute (otpCode.OTP_TTL_MS), so only a
 * code issued in the minute around the deploy needs a resend. A password reset already verified
 * before the deploy (verifiedAtForgetCase, resetExpiresAt) is not a code and is unaffected.
 */
module.exports = {
  async up(queryInterface) {
    await addColumnIfMissing(queryInterface, 'otpVerifications', 'codePurpose', {
      type: DataTypes.STRING(32),
      allowNull: true,
      defaultValue: null,
      comment: "What the current code was issued for: 'signup' or 'password_reset'",
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'otpVerifications', 'codePurpose');
  },
};

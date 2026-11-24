'use strict';

const { DataTypes } = require('sequelize');
const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/**
 * otpVerifications.failedAttempts: wrong guesses at the account's current emailed code.
 * The code is invalidated once the limit is reached (services/shared/passwordReset.js), and
 * every new code starts again at 0 (services/shared/otpCode.js freshCodeColumns).
 */
module.exports = {
  async up(queryInterface) {
    await addColumnIfMissing(queryInterface, 'otpVerifications', 'failedAttempts', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Wrong guesses at the current code; the code is invalidated at the limit',
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'otpVerifications', 'failedAttempts');
  },
};

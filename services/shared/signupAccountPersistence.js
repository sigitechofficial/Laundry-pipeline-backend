'use strict';

/**
 * Atomic persistence for email + OTP sign-up (customers and shop agents).
 *
 * All rows of a sign-up — user, OTP and device token — are written in ONE transaction:
 * a failure at any step leaves no partial account. Sign-up does not touch Stripe; the
 * Stripe customer is created on first payment (services/shared/stripeCustomerService.js).
 * Side effects that cannot be rolled back (OTP email) are the caller's job, after commit.
 *
 * Dependencies are injected so the flow is unit-testable (tests/signupAccountPersistence.test.js).
 */

const { CODE_PURPOSES, freshCodeColumns } = require('./otpCode');

/**
 * A new sign-up code starts a fresh code lifecycle on the account's row
 * (services/shared/otpCode.js); it verifies the sign-up only.
 */
function otpValues(otp) {
  return freshCodeColumns(otp, CODE_PURPOSES.SIGNUP);
}

/**
 * New, unverified account.
 * @param {{ sequelize, users, otpVerification, deviceToken }} deps
 * @param {{ userTypeId: number, profile: object, passwordHash: string, otp: object,
 *           pushToken?: string, deviceId?: string, firebaseProjectId?: string }} input
 *   pushToken: a real FCM token of the signing-up install (deviceId), registered with the
 *   account so it gets pushes once verified; firebaseProjectId: the project that issued it.
 * @returns {Promise<{ user, otpRow }>}
 */
async function createUnverifiedAccount(deps, input) {
  const { sequelize, users, otpVerification, deviceToken } = deps;
  const { userTypeId, profile, passwordHash, otp, pushToken, deviceId = null, firebaseProjectId = null } = input;

  return sequelize.transaction(async (transaction) => {
    const user = await users.create(
      { ...profile, userTypeId, password: passwordHash, status: true },
      { transaction }
    );
    const otpRow = await otpVerification.create({ ...otpValues(otp), userId: user.id }, { transaction });
    if (pushToken) {
      await deviceToken.create(
        { tokenId: pushToken, deviceId, firebaseProjectId, status: true, userId: user.id },
        { transaction }
      );
    }
    return { user, otpRow };
  });
}

/**
 * Existing, not-yet-verified account signing up again: refresh details and OTP atomically.
 * @param {{ sequelize, users, otpVerification }} deps
 * @param {{ id: number }} existing
 * @param {{ profile: object, passwordHash: string, otp: object }} input
 * @returns {Promise<{ otpRow }>}
 */
async function refreshUnverifiedAccount(deps, existing, input) {
  const { sequelize, users, otpVerification } = deps;
  const { profile, passwordHash, otp } = input;

  return sequelize.transaction(async (transaction) => {
    await users.update({ ...profile, password: passwordHash }, { where: { id: existing.id }, transaction });
    let otpRow = await otpVerification.findOne({ where: { userId: existing.id }, transaction });
    if (otpRow) {
      await otpRow.update(otpValues(otp), { transaction });
    } else {
      otpRow = await otpVerification.create({ ...otpValues(otp), userId: existing.id }, { transaction });
    }
    return { otpRow };
  });
}

module.exports = { createUnverifiedAccount, refreshUnverifiedAccount };

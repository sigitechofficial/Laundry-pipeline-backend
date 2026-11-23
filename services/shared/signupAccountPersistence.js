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

function otpValues(otp) {
  return { OTP: otp.code, reqAt: otp.requestedAt, expirtAt: otp.expiresAt };
}

/**
 * New, unverified account.
 * @param {{ sequelize, users, otpVerification, deviceToken }} deps
 * @param {{ userTypeId: number, profile: object, passwordHash: string, otp: object, dvToken?: string }} input
 * @returns {Promise<{ user, otpRow }>}
 */
async function createUnverifiedAccount(deps, input) {
  const { sequelize, users, otpVerification, deviceToken } = deps;
  const { userTypeId, profile, passwordHash, otp, dvToken } = input;

  return sequelize.transaction(async (transaction) => {
    const user = await users.create(
      { ...profile, userTypeId, password: passwordHash, status: true },
      { transaction }
    );
    const otpRow = await otpVerification.create({ ...otpValues(otp), userId: user.id }, { transaction });
    if (dvToken) {
      await deviceToken.create({ tokenId: dvToken, status: true, userId: user.id }, { transaction });
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

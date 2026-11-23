'use strict';

/**
 * Atomic persistence for customer sign-up (email + OTP flow).
 *
 * A sign-up writes to two systems: Stripe (customer) and MySQL (user, OTP, device token).
 * They cannot share one transaction, so the order is:
 *   1. Stripe customer first — if Stripe fails, nothing has been written anywhere.
 *   2. All MySQL rows in ONE transaction — all or nothing.
 *   3. If the transaction fails, delete the Stripe customer created in step 1
 *      (compensation), so no orphan is left on either side.
 * Side effects that cannot be undone (OTP email) happen only after commit, in the caller.
 *
 * No custom Stripe idempotency key on purpose: a retried sign-up after a compensated
 * failure would replay the deleted customer's id. stripe-node already sends idempotency
 * keys on its own network retries.
 *
 * Dependencies are injected so the flow is unit-testable (tests/customerSignupPersistence.test.js).
 */

async function compensateStripeCustomer(stripeApi, stripeCustomerId, log) {
  try {
    await stripeApi.deleteCustomer(stripeCustomerId);
  } catch (cleanupError) {
    // Do not mask the original failure; make the orphan findable for ops.
    log(
      `[customer-signup] Failed to delete Stripe customer ${stripeCustomerId} after a ` +
        `database failure — remove it manually: ${cleanupError.message}`
    );
  }
}

/**
 * New customer: Stripe customer + user + OTP (+ device token), atomically.
 * @returns {Promise<{ user, otpRow, stripeCustomerId }>}
 */
async function createUnverifiedCustomer(deps, input) {
  const { stripeApi, sequelize, users, otpVerification, deviceToken, log = console.error } = deps;
  const { profile, passwordHash, otp, dvToken } = input;

  const stripeCustomerId = await stripeApi.createCustomer({
    name: profile.firstName,
    email: profile.email,
  });

  try {
    return await sequelize.transaction(async (transaction) => {
      const user = await users.create(
        {
          ...profile,
          userTypeId: 2,
          password: passwordHash,
          status: true,
          stripeCustomerId,
        },
        { transaction }
      );
      const otpRow = await otpVerification.create(
        { OTP: otp.code, reqAt: otp.requestedAt, expirtAt: otp.expiresAt, userId: user.id },
        { transaction }
      );
      if (dvToken) {
        await deviceToken.create({ tokenId: dvToken, status: true, userId: user.id }, { transaction });
      }
      return { user, otpRow, stripeCustomerId };
    });
  } catch (error) {
    await compensateStripeCustomer(stripeApi, stripeCustomerId, log);
    throw error;
  }
}

/**
 * Existing, not-yet-verified customer signing up again: refresh details and OTP atomically.
 * Reuses the customer's Stripe record (renamed if needed) instead of creating a new one;
 * creates one only if the account never got one, and compensates that on failure.
 * @returns {Promise<{ otpRow, stripeCustomerId }>}
 */
async function refreshUnverifiedCustomer(deps, existing, input) {
  const { stripeApi, sequelize, users, otpVerification, log = console.error } = deps;
  const { profile, passwordHash, otp } = input;

  let stripeCustomerId = existing.stripeCustomerId || null;
  let createdStripeCustomerId = null;
  if (!stripeCustomerId) {
    stripeCustomerId = await stripeApi.createCustomer({ name: profile.firstName, email: profile.email });
    createdStripeCustomerId = stripeCustomerId;
  } else if (profile.firstName !== existing.firstName) {
    await stripeApi.updateCustomer(stripeCustomerId, { name: profile.firstName });
  }

  try {
    return await sequelize.transaction(async (transaction) => {
      await users.update(
        { ...profile, password: passwordHash, stripeCustomerId },
        { where: { id: existing.id }, transaction }
      );
      const otpValues = { OTP: otp.code, reqAt: otp.requestedAt, expirtAt: otp.expiresAt };
      let otpRow = await otpVerification.findOne({ where: { userId: existing.id }, transaction });
      if (otpRow) {
        await otpRow.update(otpValues, { transaction });
      } else {
        otpRow = await otpVerification.create({ ...otpValues, userId: existing.id }, { transaction });
      }
      return { otpRow, stripeCustomerId };
    });
  } catch (error) {
    if (createdStripeCustomerId) await compensateStripeCustomer(stripeApi, createdStripeCustomerId, log);
    throw error;
  }
}

module.exports = { createUnverifiedCustomer, refreshUnverifiedCustomer };

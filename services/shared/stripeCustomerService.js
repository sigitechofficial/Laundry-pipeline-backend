'use strict';

/**
 * Stripe customer lifecycle: a user's Stripe customer is created when it is first
 * needed (saving a card / paying), never at sign-up.
 *
 * Why not at sign-up: sign-up would depend on Stripe being up, would need cross-system
 * compensation, and every abandoned or never-verified sign-up (and every shop/agent
 * account, which never pays as a customer) would leave an unused Stripe customer.
 *
 * ensureStripeCustomer is the single place that creates one:
 *  - Concurrency-safe: the user row is locked (SELECT … FOR UPDATE), so two parallel
 *    payment requests cannot create two Stripe customers for the same user.
 *  - Stripe customer carries metadata.userId for reconciliation.
 *  - If saving the id fails, the new Stripe customer is deleted (compensation).
 */

function defaultDeps() {
  const db = require('../../models');
  const stripe = require('../../controllers/stripe');
  return {
    sequelize: db.sequelize,
    users: db.users,
    stripeApi: {
      createCustomer: ({ name, email, metadata }) => stripe.createStripeCustomer(name, email, metadata),
      deleteCustomer: (id) => stripe.deleteStripeCustomer(id),
    },
    log: console.error,
  };
}

function displayName(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email;
}

/**
 * @param {number} userId
 * @returns {Promise<string>} Stripe customer id (existing or newly created)
 */
async function ensureStripeCustomer(userId, deps = defaultDeps()) {
  const { sequelize, users, stripeApi, log = console.error } = deps;
  const attributes = ['id', 'firstName', 'lastName', 'email', 'stripeCustomerId'];

  // Fast path without a lock: almost every call after the first payment.
  const current = await users.findByPk(userId, { attributes });
  if (!current) throw new Error(`User ${userId} not found`);
  if (current.stripeCustomerId) return current.stripeCustomerId;

  let createdId = null;
  try {
    return await sequelize.transaction(async (transaction) => {
      const user = await users.findByPk(userId, { attributes, transaction, lock: transaction.LOCK.UPDATE });
      if (user.stripeCustomerId) return user.stripeCustomerId; // a parallel request created it

      createdId = await stripeApi.createCustomer({
        name: displayName(user),
        email: user.email,
        metadata: { userId: String(user.id) },
      });
      await users.update({ stripeCustomerId: createdId }, { where: { id: user.id }, transaction });
      return createdId;
    });
  } catch (error) {
    if (createdId) {
      try {
        await stripeApi.deleteCustomer(createdId);
      } catch (cleanupError) {
        log(
          `[stripe-customer] Failed to delete Stripe customer ${createdId} for user ${userId} ` +
            `after a database failure — remove it manually: ${cleanupError.message}`
        );
      }
    }
    throw error;
  }
}

module.exports = { ensureStripeCustomer };

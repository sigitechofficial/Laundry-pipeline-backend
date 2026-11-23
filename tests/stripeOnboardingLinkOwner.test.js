'use strict';

/**
 * GET /agent/generateStripeOnboardingLink returns a Stripe onboarding link for the
 * signed-in owner's own shop account only. Installed builds still send
 * ?connectAccountId=; it is ignored, so a caller can never get a link that lets it
 * edit another shop's payout details.
 * Pure: authService and the session stores are stubbed (no models, Redis, Stripe).
 *   node tests/stripeOnboardingLinkOwner.test.js
 */

const assert = require('assert');
const Module = require('module');

const calls = [];
const authService = {
  generateStripeOnboardingLink: async (data) => {
    calls.push(data);
    return { connectAccountId: `acct_shop_${data.shopOwnerId}`, onboardingUrl: 'https://connect.stripe.test/x' };
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '../../services/Agent/authService') return authService;
  if (request === '../../utils/deviceTokenStore') return { saveCurrentToken: async () => {} };
  if (request === '../../utils/appSession') {
    return { identityOfSession: () => ({}), normalizeDeviceId: (v) => v };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { attachShopAgentContext } = require('../utils/shopAgentContext');
const authController = require('../controllers/Agent/authController');
Module._load = originalLoad;

function recorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
}

(async () => {
  // Owner 2 whose installed app sends another shop's account id: still its own shop.
  const req = attachShopAgentContext({
    user: { id: 2, email: 'owner@example.test' },
    query: { connectAccountId: 'acct_someone_else' },
    params: {},
    body: {},
  });
  const res = recorder();
  await authController.generateStripeOnboardingLink(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(calls, [{ shopOwnerId: 2 }], 'service gets only the caller shop, never the query id');
  assert.strictEqual(res.body.data.connectAccountId, 'acct_shop_2');

  // No query param at all (first-time setup in the app) works the same way.
  calls.length = 0;
  const res2 = recorder();
  await authController.generateStripeOnboardingLink(
    attachShopAgentContext({ user: { id: 3 }, query: {}, params: {}, body: {} }),
    res2
  );
  assert.strictEqual(res2.statusCode, 200);
  assert.deepStrictEqual(calls, [{ shopOwnerId: 3 }]);

  console.log('stripeOnboardingLinkOwner tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

'use strict';

/**
 * Stripe charges, holds and transfers are in the record's own currency (lower-cased for
 * Stripe), never a hard-coded 'gbp' / 'usd'; a missing currency never reaches Stripe.
 * Run: node tests/stripeChargeCurrency.test.js
 */

const assert = require('assert/strict');
const Module = require('module');

const sent = [];
const fakeStripe = {
  paymentIntents: {
    create: async (params) => {
      sent.push(['paymentIntent', params]);
      return { id: 'pi_test', status: params.capture_method === 'manual' ? 'requires_capture' : 'succeeded' };
    },
  },
  transfers: {
    create: async (params) => {
      sent.push(['transfer', params]);
      return { id: 'tr_test' };
    },
  },
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'stripe') return () => fakeStripe;
  return originalLoad.call(this, request, parent, isMain);
};

const stripe = require('../controllers/stripe');
const { buildStripeChargePresentation } = require('../utils/stripePaymentMetadata');

(async () => {
  for (const gone of ['createPaymentIntend', 'createPaymentIntendForUpFrontPayments', 'createPaymentIntentForAgent']) {
    assert.equal(stripe[gone], undefined, `${gone} (hard-coded currency, unused) is removed`);
  }

  const presentation = buildStripeChargePresentation({
    chargeType: 'delivery_balance', bookingId: 7, amount: 12.5, currency: 'eur', customer: { id: 1 }, agent: { id: 2 },
  });
  assert.equal(presentation.currency, 'EUR', 'presentation carries the charge currency');

  await stripe.chargeOffSession(12.5, 'cus_1', 'pm_1', 'key-1', presentation);
  assert.equal(sent.at(-1)[1].currency, 'eur');
  assert.equal(sent.at(-1)[1].amount, 1250);

  await stripe.createAuthorizationHold(20, 'cus_1', 'pm_1', 'hold-1', { currency: 'USD' });
  assert.equal(sent.at(-1)[1].currency, 'usd');

  await stripe.transferToConnectAccount(5, 'acct_1', 'tr-1', {}, { currency: 'GBP' });
  assert.equal(sent.at(-1)[0], 'transfer');
  assert.equal(sent.at(-1)[1].currency, 'gbp');

  // No currency: refused before Stripe is called.
  const before = sent.length;
  await assert.rejects(stripe.chargeOffSession(5, 'cus_1', 'pm_1', 'key-2'), /currency code is required/);
  await assert.rejects(stripe.chargeOffSession(5, 'cus_1', 'pm_1', 'key-3', { currency: '' }), /currency code is required/);
  await assert.rejects(stripe.createAuthorizationHold(5, 'cus_1', 'pm_1', 'hold-2', {}), /currency code is required/);
  await assert.rejects(stripe.transferToConnectAccount(5, 'acct_1', 'tr-2', {}, {}), /currency code is required/);
  assert.equal(sent.length, before, 'nothing sent to Stripe without a currency');

  console.log('stripeChargeCurrency.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(() => {
  Module._load = originalLoad;
});

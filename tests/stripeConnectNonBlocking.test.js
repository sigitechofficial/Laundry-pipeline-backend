'use strict';

/**
 * Shop registration never depends on Stripe. The Connect account is made with
 * AgentAuthService._createConnectAccountSafely: when Stripe refuses or is down it logs,
 * returns null and the registration carries on to admin approval (it used to throw, so
 * POST /agent/addBusinessInfor answered 500 and the shop never finished registering).
 * The account is then made when the owner connects Stripe.
 *
 *   node tests/stripeConnectNonBlocking.test.js
 */

const assert = require('assert');
const stripe = require('../controllers/stripe');
const models = require('../models');
const authService = require('../services/Agent/authService');

(async () => {
    const realCreate = stripe.createStripeConnectAccount;
    const realUpdate = models.bussinessInformation.update;
    const realError = console.error;
    const updates = [];
    models.bussinessInformation.update = async (values, opts) => { updates.push({ values, opts }); return [1]; };
    console.error = () => {};
    try {
        // 1. Stripe refuses: no throw, null, nothing stored.
        stripe.createStripeConnectAccount = async () => { throw new Error('platform profile incomplete'); };
        const failed = await authService._createConnectAccountSafely({
            businessInfoId: 5, shopId: 9, email: 'shop@example.com', countryCode: '+44',
        });
        assert.strictEqual(failed, null);
        assert.strictEqual(updates.length, 0);

        // 2. Stripe returns nothing: treated the same.
        stripe.createStripeConnectAccount = async () => null;
        assert.strictEqual(await authService._createConnectAccountSafely({ businessInfoId: 5, shopId: 9, email: 'a@b.c' }), null);

        // 3. Stripe works: the account is stored on the shop's business information.
        let countryUsed;
        stripe.createStripeConnectAccount = async (email, country) => { countryUsed = country; return 'acct_123'; };
        const ok = await authService._createConnectAccountSafely({
            businessInfoId: 5, shopId: 9, email: 'shop@example.com', countryCode: '+44',
        });
        assert.strictEqual(ok, 'acct_123');
        assert.strictEqual(countryUsed, 'GB', 'a dial code is not a country: GB is used');
        assert.deepStrictEqual(updates[0].values, { connectAccountId: 'acct_123', isConnectAccountConnected: false });
        assert.deepStrictEqual(updates[0].opts, { where: { id: 5 } });

        // 4. A real ISO code is kept; "UK" means GB.
        await authService._createConnectAccountSafely({ businessInfoId: 5, shopId: 9, email: 'x@y.z', countryCode: 'ie' });
        assert.strictEqual(countryUsed, 'IE');
        await authService._createConnectAccountSafely({ businessInfoId: 5, shopId: 9, email: 'x@y.z', countryCode: 'UK' });
        assert.strictEqual(countryUsed, 'GB');

        console.log('stripeConnectNonBlocking.test.js: ok');
    } finally {
        stripe.createStripeConnectAccount = realCreate;
        models.bussinessInformation.update = realUpdate;
        console.error = realError;
    }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });

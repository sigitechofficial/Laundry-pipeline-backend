'use strict';

const assert = require('assert');
const { isPromotionsCheckoutEnabled: on } = require('../services/promotions/checkoutFlag');

assert.strictEqual(on(1, {}), false, 'off by default');
assert.strictEqual(on(1, { PROMOTIONS_CHECKOUT_ENABLED: 'false' }), false);
assert.strictEqual(on(1, { PROMOTIONS_CHECKOUT_ENABLED: '1' }), false, 'only "true" turns it on');
assert.strictEqual(on(1, { PROMOTIONS_CHECKOUT_ENABLED: 'true' }), true, 'all zones when no allowlist');
assert.strictEqual(on(1, { PROMOTIONS_CHECKOUT_ENABLED: ' TRUE ' }), true);
assert.strictEqual(on(3, { PROMOTIONS_CHECKOUT_ENABLED: 'true', PROMOTIONS_CHECKOUT_ZONE_IDS: '3, 7' }), true);
assert.strictEqual(on('7', { PROMOTIONS_CHECKOUT_ENABLED: 'true', PROMOTIONS_CHECKOUT_ZONE_IDS: '3,7' }), true);
assert.strictEqual(on(4, { PROMOTIONS_CHECKOUT_ENABLED: 'true', PROMOTIONS_CHECKOUT_ZONE_IDS: '3,7' }), false, 'zone not listed');
assert.strictEqual(on(null, { PROMOTIONS_CHECKOUT_ENABLED: 'true', PROMOTIONS_CHECKOUT_ZONE_IDS: '3' }), false, 'unknown zone with allowlist');
assert.strictEqual(on(4, { PROMOTIONS_CHECKOUT_ENABLED: 'true', PROMOTIONS_CHECKOUT_ZONE_IDS: ' , x' }), true, 'junk allowlist = every zone');

console.log('✅ Promotions checkout flag: all passed');

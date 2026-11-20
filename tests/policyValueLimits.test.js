'use strict';
const assert = require('assert');
const { assertPolicyValues } = require('../utils/policyValueLimits');

const rejects = (config, pattern) => assert.throws(() => assertPolicyValues(config), pattern);
rejects({ prePickupPercentage: 150 }, /more than 100%/);
rejects({ atDeliveryPercentage: '101' }, /more than 100%/);
rejects({ pickupNoShowFee: -5 }, /negative/);
rejects({ courtesyCapAmount: 'abc' }, /must be a number/);
rejects({ courtesyCount: 1.5 }, /whole number/);
rejects({ graceMinutesOnSite: -1 }, /negative/);
assertPolicyValues({
  prePickupPercentage: '20', prePickupAbsoluteAmount: 5, prePickupFreeChargeWindowMinutes: 1440,
  prePickupAbsoluteCurrency: 'GBP', feeType: 'absolute', autoForgiveFirstNoShow: true, courtesyCapAmount: '', storageFeePerDay: null,
});
console.log('policyValueLimits.test.js: all assertions passed');

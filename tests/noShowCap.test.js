'use strict';
const assert = require('assert');

/**
 * E9: after the per-customer cap, no-shows are charged (no more auto-forgive), unless
 * "Require payment after cap" is turned off. A late driver always waives the fee.
 */
(async () => {
  const service = require('../services/Agent/noShowEnforcementService');
  const fee = async ({ prior, config, late = 0 }) => {
    service._countCustomerFailedAttempts = async () => prior;
    return service.calculateNoShowFee({
      bookingData: { customerId: 1, orderAmount: 40 },
      attemptType: 'pickup',
      driverLateMinutes: late,
      policyRecord: { noShowConfig: { enableForPickup: true, feeType: 'absolute', pickupNoShowFee: 5, currency: 'GBP', autoForgiveFirstNoShow: true, autoForgiveCount: 5, autoForgivePeriod: 30, perCustomerCap: 2, capWindowDays: 90, ...config } },
    });
  };
  let r = await fee({ prior: 0, config: {} });
  assert.equal(r.feeAmount, 0); assert.equal(r.policyApplied, 'auto_forgive');            // under the cap: forgiven
  r = await fee({ prior: 2, config: {} });
  assert.equal(r.feeAmount, 5); assert.equal(r.policyApplied, 'payment_after_cap');        // cap reached: charged
  r = await fee({ prior: 2, config: { requirePaymentAfterCap: false } });
  assert.equal(r.feeAmount, 0); assert.equal(r.policyApplied, 'customer_cap');             // switch off: old waiver
  r = await fee({ prior: 3, config: {}, late: 30 });
  assert.equal(r.feeAmount, 0); assert.equal(r.policyApplied, 'driver_late_waiver');       // late driver always waives
  console.log('noShowCap.test.js: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

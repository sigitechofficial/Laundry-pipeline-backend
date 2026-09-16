'use strict';

const assert = require('assert');
const { presentShopOrderFinance } = require('./shopOrderFinance');

const billed = presentShopOrderFinance({
  orderAmount: 40,
  rescheduleCharge: 0,
  billingDetail: {
    total: 30,
    categoryCharge: 20,
    serviceCharge: 5,
    zoneAdminCommission: 4,
    agentEarning: 16,
    pickupDriverEarning: 1,
    deliveryDriverEarning: 1,
  },
});
assert.strictEqual(billed.serviceCharge, 5);
assert.strictEqual(billed.platformCommission, 4);
assert.strictEqual(billed.platformTake, 9);
assert.strictEqual(billed.shopNet, 16);

const derived = presentShopOrderFinance({
  orderAmount: 30,
  rescheduleCharge: 0,
  billingDetail: {
    total: 30,
    categoryCharge: 20,
    serviceCharge: 5,
    zoneAdminCommission: 4,
    pickupDriverEarning: 1,
    deliveryDriverEarning: 1,
  },
});
assert.strictEqual(derived.shopNet, 19);
assert.strictEqual(derived.platformTake, 9);

const fullRefund = presentShopOrderFinance(
  {
    orderAmount: 30,
    billingDetail: {
      total: 30,
      categoryCharge: 20,
      serviceCharge: 5,
      zoneAdminCommission: 4,
      agentEarning: 16,
      pickupDriverEarning: 1,
      deliveryDriverEarning: 1,
    },
  },
  30
);
assert.strictEqual(fullRefund.isFullyRefunded, true);
assert.strictEqual(fullRefund.gross, 0);
assert.strictEqual(fullRefund.shopNet, 0);
assert.strictEqual(fullRefund.platformTake, 0);

const partialRefund = presentShopOrderFinance(
  {
    orderAmount: 30,
    billingDetail: {
      total: 30,
      categoryCharge: 20,
      serviceCharge: 5,
      zoneAdminCommission: 4,
      agentEarning: 16,
      pickupDriverEarning: 1,
      deliveryDriverEarning: 1,
    },
  },
  10
);
assert.strictEqual(partialRefund.gross, 20);
assert.strictEqual(partialRefund.shopNet, 9);
assert.strictEqual(partialRefund.platformTake, 9);

// Agent-built invoices never stored categoryCharge: derive laundry from the
// invoice value (orderAmount = laundry + service fee + booking tip).
const legacyLaundry = presentShopOrderFinance({
  orderAmount: 89.75,
  rescheduleCharge: 0,
  tips: [{ amount: 5, source: "booking" }, { amount: 3, source: "post_complete" }],
  billingDetail: {
    total: 89.75,
    categoryCharge: null,
    serviceCharge: 20,
    zoneAdminCommission: 12.95,
    agentEarning: 56.8,
  },
});
assert.strictEqual(legacyLaundry.laundry, 64.75);
assert.strictEqual(billed.laundry, 20, "stored categoryCharge still wins");

console.log('shopOrderFinance tests passed');

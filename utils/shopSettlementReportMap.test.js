"use strict";

const assert = require("assert");
const {
  mapSettlementReport,
  emptySettlementReport,
} = require("./shopSettlementReportMap");

const mapped = mapSettlementReport({
  ordersPaid: 10,
  customers: 7,
  cashOrders: 6,
  cardOrders: 4,
  mixedOrders: 1,
  cashCustomers: 5,
  cardCustomers: 4,
  mixedCustomers: 1,
  gross: 100,
  laundry: 80,
  serviceFee: 10,
  platformCommission: 16,
  platformTake: 26,
  shopNet: 60,
  driverEarnings: 8,
  discount: 2,
  cashGross: 55,
  cardGross: 45,
  mixedGross: 12,
  cashLaundry: 40,
  cardLaundry: 40,
  mixedLaundry: 10,
  cashServiceFee: 6,
  cardServiceFee: 4,
  mixedServiceFee: 1,
  cashCommission: 8,
  cardCommission: 8,
  mixedCommission: 2,
  cashPlatformTake: 14,
  cardPlatformTake: 12,
  mixedPlatformTake: 3,
  cashShopNet: 30,
  cardShopNet: 30,
  mixedShopNet: 8,
});

assert.strictEqual(mapped.ordersPaid, 10);
assert.strictEqual(mapped.customers, 7);
assert.strictEqual(mapped.customersWhoUsedBoth, 2);
assert.strictEqual(mapped.platformTake, 26);
assert.strictEqual(mapped.serviceFee, 10);
assert.strictEqual(mapped.cash.orders, 6);
assert.strictEqual(mapped.card.orders, 4);
assert.strictEqual(mapped.mixed.orders, 1);
assert.strictEqual(mapped.card.customers, 4);
assert.deepStrictEqual(emptySettlementReport().card.orders, 0);

console.log("shopSettlementReportMap tests passed");

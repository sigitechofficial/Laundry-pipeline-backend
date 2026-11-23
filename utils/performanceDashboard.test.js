'use strict';

const assert = require('assert');
const {
  DRIVER_SIDE,
  driverSide,
  percentChange,
  summarizeLegs,
  buildCommissionSummary,
} = require('./performanceDashboard');

const LONDON = 'Europe/London';
const OWNER = 2;
const STAFF_DRIVER = 5;
const MANAGER = 4;
const FREELANCER = 90;

// Driver side.
const staff = new Set([STAFF_DRIVER, MANAGER]);
assert.strictEqual(driverSide(OWNER, OWNER, staff), DRIVER_SIDE.OWNER);
assert.strictEqual(driverSide('5', OWNER, staff), DRIVER_SIDE.STAFF);
assert.strictEqual(driverSide(FREELANCER, OWNER, staff), DRIVER_SIDE.THIRD_PARTY);
assert.strictEqual(driverSide(null, OWNER, staff), null);

// % change: signed, 1 decimal, null with nothing to compare (not a fake 0).
assert.strictEqual(percentChange(150, 100), 50);
assert.strictEqual(percentChange(50, 200), -75);
assert.strictEqual(percentChange(10, 3), 233.3);
assert.strictEqual(percentChange(10, 0), null);
assert.strictEqual(percentChange(0, 0), null);

// Legs: slot 10:00-11:00 London on 2 Jul (BST) = 09:00-10:00 UTC.
const slot = { slotDay: '2026-07-02', slotFrom: '10:00:00', slotTo: '11:00:00', slotTimeZone: LONDON };
const legs = [
  { kind: 'pickup', userId: OWNER, arrivedAt: '2026-07-02T09:30:00Z', ...slot }, // on time
  { kind: 'pickup', userId: OWNER, arrivedAt: '2026-07-02T10:20:00Z', ...slot }, // late 20
  { kind: 'pickup', userId: MANAGER, arrivedAt: '2026-07-02T08:00:00Z', ...slot }, // early
  { kind: 'pickup', userId: null, arrivedAt: null, ...slot }, // unattributed
  { kind: 'delivery', userId: OWNER, arrivedAt: '2026-07-02T10:40:00Z', ...slot }, // late 40
  { kind: 'delivery', userId: STAFF_DRIVER, arrivedAt: '2026-07-02T09:59:00Z', ...slot }, // on time
  { kind: 'delivery', userId: STAFF_DRIVER, arrivedAt: null, ...slot }, // no arrival recorded
  { kind: 'delivery', userId: FREELANCER, arrivedAt: '2026-07-02T09:10:00Z', ...slot, slotTimeZone: null }, // no zone
  { kind: 'delivery', userId: null, arrivedAt: null, ...slot },
];
const people = new Map([
  [OWNER, { firstName: 'Olive', lastName: 'Owner' }],
  [STAFF_DRIVER, { firstName: 'Sam', lastName: 'Staff' }],
  [MANAGER, { firstName: 'Mia', lastName: 'Manager' }],
  [FREELANCER, { firstName: 'Fred', lastName: 'Free' }],
  [7, { firstName: 'Idle', lastName: 'Driver' }],
]);
const out = summarizeLegs({
  legs,
  ownerId: OWNER,
  employeeIds: [STAFF_DRIVER, MANAGER, 7],
  people,
  rosterDriverIds: [STAFF_DRIVER, 7],
});

assert.strictEqual(out.pickups, 4);
assert.strictEqual(out.deliveries, 5);
// Split covers every delivery: own (owner + staff) / third party / unattributed.
assert.deepStrictEqual(out.deliveryTypeSplit, {
  agentDriversDeliveries: 3,
  freelanceDriverDeliveries: 1,
  unattributedDeliveries: 1,
});
const split = out.deliveryTypeSplit;
assert.strictEqual(
  split.agentDriversDeliveries + split.freelanceDriverDeliveries + split.unattributedDeliveries,
  out.deliveries
);

const byId = new Map(out.driverPerformance.map((r) => [r.id, r]));
assert.deepStrictEqual(
  out.driverPerformance.map((r) => r.id),
  [OWNER, STAFF_DRIVER, FREELANCER, MANAGER, 7] // most legs first, then name
);

const owner = byId.get(OWNER);
assert.strictEqual(owner.driverType, DRIVER_SIDE.OWNER);
assert.strictEqual(owner.firstName, 'Olive');
assert.strictEqual(owner.pickups, 2);
assert.strictEqual(owner.deliveries, 1);
assert.deepStrictEqual(owner.collectionPunctuality, {
  measured: 2, early: 0, onTime: 1, late: 1, unmeasured: 0, onTimePercent: 50, averageMinutesLate: 20,
});
assert.deepStrictEqual(owner.deliveryPunctuality, {
  measured: 1, early: 0, onTime: 0, late: 1, unmeasured: 0, onTimePercent: 0, averageMinutesLate: 40,
});

const driver = byId.get(STAFF_DRIVER);
assert.strictEqual(driver.driverType, DRIVER_SIDE.STAFF);
assert.strictEqual(driver.deliveries, 2);
assert.deepStrictEqual(driver.deliveryPunctuality, {
  measured: 1, early: 0, onTime: 1, late: 0, unmeasured: 1, onTimePercent: 100, averageMinutesLate: null,
});
assert.deepStrictEqual(driver.collectionPunctuality, {
  measured: 0, early: 0, onTime: 0, late: 0, unmeasured: 0, onTimePercent: null, averageMinutesLate: null,
});

const manager = byId.get(MANAGER);
assert.strictEqual(manager.driverType, DRIVER_SIDE.STAFF);
assert.strictEqual(manager.collectionPunctuality.early, 1);
assert.strictEqual(manager.collectionPunctuality.onTimePercent, 0);

const freelancer = byId.get(FREELANCER);
assert.strictEqual(freelancer.driverType, DRIVER_SIDE.THIRD_PARTY);
assert.strictEqual(freelancer.deliveryPunctuality.unmeasured, 1);
assert.strictEqual(freelancer.deliveryPunctuality.onTimePercent, null);

// Roster driver with nothing in range is still listed, with zeros.
const idle = byId.get(7);
assert.strictEqual(idle.pickups, 0);
assert.strictEqual(idle.deliveries, 0);
assert.strictEqual(idle.collectionPunctuality.onTimePercent, null);

// Empty range.
const none = summarizeLegs({ legs: [], ownerId: OWNER, employeeIds: [], people: new Map() });
assert.deepStrictEqual(none, {
  pickups: 0,
  deliveries: 0,
  deliveryTypeSplit: { agentDriversDeliveries: 0, freelanceDriverDeliveries: 0, unattributedDeliveries: 0 },
  driverPerformance: [],
});

// Commission summary: money rounded to pennies, rates grouped by frozen %.
assert.deepStrictEqual(
  buildCommissionSummary(
    { orders: 3, shopEarning: '72.005', platformCommission: 18.1, platformServiceFees: 7.5 },
    [
      { shopPercent: 90, platformPercent: 10, orders: 1 },
      { shopPercent: 80, platformPercent: 20, orders: 2 },
      { shopPercent: null, platformPercent: null, orders: 0 },
    ]
  ),
  {
    paidOrders: 3,
    shopEarning: 72.01,
    platformCommission: 18.1,
    platformServiceFees: 7.5,
    commissionRates: [
      { shopPercent: 80, platformPercent: 20, orders: 2 },
      { shopPercent: 90, platformPercent: 10, orders: 1 },
      { shopPercent: null, platformPercent: null, orders: 0 },
    ],
  }
);

console.log('performanceDashboard tests passed');

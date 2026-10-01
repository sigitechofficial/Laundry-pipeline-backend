'use strict';

const assert = require('assert');
const {
  computeCapacityResetAt,
  buildCapacityStatus,
  capacityReachedMessage,
} = require('./shopAcceptCapacityWindow');

const t0 = Date.parse('2026-09-28T14:00:00Z');
const min = 60 * 1000;
const at = (m) => new Date(t0 + m * min);

// Room left → no reset time.
assert.strictEqual(computeCapacityResetAt([at(0), at(10)], 4, 60), null);

// Exactly at cap (4/4): frees when the oldest accept leaves the 60-min window.
assert.strictEqual(
  computeCapacityResetAt([at(30), at(0), at(10), at(20)], 4, 60).toISOString(),
  at(60).toISOString()
);

// Over cap (admin assigns also count, 6/4): the 3 oldest must age out first.
assert.strictEqual(
  computeCapacityResetAt([at(0), at(5), at(10), at(15), at(20), at(25)], 4, 60).toISOString(),
  at(70).toISOString()
);

// Cap 0 never frees by itself; junk timestamps are ignored.
assert.strictEqual(computeCapacityResetAt([at(0)], 0, 60), null);
assert.strictEqual(computeCapacityResetAt(['nope', at(0)], 2, 60), null);

// Status snapshot.
const cap = { enabled: true, windowMinutes: 60, maxOrders: 4 };
const full = buildCapacityStatus({ cap, used: 4, resetsAt: at(60), now: t0 + 48 * min });
assert.deepStrictEqual(full, {
  enabled: true,
  limit: 4,
  used: 4,
  remaining: 0,
  windowMinutes: 60,
  atCapacity: true,
  resetsAt: at(60).toISOString(),
  resetsInSeconds: 12 * 60,
});
const open = buildCapacityStatus({ cap, used: 2, resetsAt: null, now: t0 });
assert.strictEqual(open.atCapacity, false);
assert.strictEqual(open.remaining, 2);
assert.strictEqual(open.resetsAt, null);
assert.strictEqual(buildCapacityStatus({ cap: { enabled: false, windowMinutes: 60 } }).enabled, false);

// Message (London in September = BST, UTC+1 → 16:00).
assert.strictEqual(
  capacityReachedMessage(full, 'Europe/London'),
  'You have reached your limit of 4 orders in 60 minutes. You can accept again at 16:00 (in 12 min).'
);
assert.match(capacityReachedMessage({ limit: 0 }, 'Europe/London'), /limit set to 0/);

console.log('shopAcceptCapacityWindow tests passed');

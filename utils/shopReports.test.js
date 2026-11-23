'use strict';

const assert = require('assert');
const { statusBuckets, legPunctuality } = require('./shopReports');

// Statuses by id: every order lands in exactly one bucket. Issue Resolved (23)
// counts as completed; Refunded (21) is its own bucket (it used to read as
// "in progress"); both on-hold statuses (18, 24) are on hold.
{
  const t = statusBuckets([17, 23, 19, 21, 18, 24, 11, 16].map((id) => ({ bookingStatusId: id })));
  assert.deepStrictEqual(t, { completed: 2, inProgress: 2, onHold: 2, cancelled: 1, refunded: 1 });
  assert.strictEqual(Object.values(t).reduce((a, b) => a + b, 0), 8);
}

// Punctuality = arrival at the door vs the booked slot, in the slot's zone.
{
  const leg = (kind, arrivedAt) => ({
    kind, arrivedAt, slotDay: '2026-11-24', slotFrom: '10:00:00', slotTo: '11:00:00', slotTimeZone: 'Europe/London',
  });
  const p = legPunctuality([
    leg('pickup', '2026-11-24T10:30:00Z'), // on time
    leg('pickup', '2026-11-24T11:20:00Z'), // 20 min late
    leg('pickup', null), // no arrival recorded: unmeasured, not guessed
    leg('delivery', '2026-11-24T09:50:00Z'), // early
  ]);
  assert.strictEqual(p.pickup.measured, 2);
  assert.strictEqual(p.pickup.unmeasured, 1);
  assert.strictEqual(p.pickup.onTimePercent, 50);
  assert.strictEqual(p.pickup.averageMinutesLate, 20);
  assert.strictEqual(p.delivery.early, 1);
  assert.strictEqual(p.delivery.onTimePercent, 0);
  assert.strictEqual(legPunctuality([]).pickup.onTimePercent, null);
}

console.log('shopReports.test.js: all assertions passed');

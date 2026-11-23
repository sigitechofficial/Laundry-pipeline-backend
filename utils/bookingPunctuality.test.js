'use strict';

const assert = require('assert');
const {
  TIMING,
  calendarParts,
  classifySlotTiming,
  summarizeOrderPunctuality,
  emptyPunctuality,
  slotWindowInZone,
  classifyArrivalInZone,
} = require('./bookingPunctuality');

assert.strictEqual(
  classifySlotTiming('2026-09-15T08:30:00', '2026-09-15', '09:00:00', '11:00:00'),
  TIMING.EARLY
);
assert.strictEqual(
  classifySlotTiming('2026-09-15T10:00:00', '2026-09-15', '09:00:00', '11:00:00'),
  TIMING.ON_TIME
);
assert.strictEqual(
  classifySlotTiming('2026-09-15T11:00:00', '2026-09-15', '09:00:00', '11:00:00'),
  TIMING.ON_TIME
);
assert.strictEqual(
  classifySlotTiming('2026-09-15T11:01:00', '2026-09-15', '09:00:00', '11:00:00'),
  TIMING.LATE
);
assert.strictEqual(
  classifySlotTiming(null, '2026-09-15', '09:00:00', '11:00:00'),
  null
);

const summary = summarizeOrderPunctuality([
  { pickupTiming: 'early', deliveryTiming: 'on_time' },
  { pickupTiming: 'late', deliveryTiming: 'late' },
  { pickupTiming: 'on_time', deliveryTiming: null },
]);
assert.strictEqual(summary.earlyPickups, 1);
assert.strictEqual(summary.onTimePickups, 1);
assert.strictEqual(summary.latePickups, 1);
assert.strictEqual(summary.onTimeDeliveries, 1);
assert.strictEqual(summary.lateDeliveries, 1);
assert.strictEqual(summary.pickupsCompleted, 3);
assert.deepStrictEqual(emptyPunctuality().earlyPickups, 0);

assert.deepStrictEqual(calendarParts(new Date(Date.UTC(2026, 8, 15))), {
  year: 2026,
  month: 9,
  day: 15,
});
assert.strictEqual(
  classifySlotTiming(
    '2026-09-15T10:00:00',
    new Date(Date.UTC(2026, 8, 15)),
    '09:00:00',
    '11:00:00'
  ),
  TIMING.ON_TIME
);

// Zone-aware slot: the wall clock is the booking's operational zone, whatever
// the server's zone is. 10:00-11:00 London in BST = 09:00-10:00 UTC.
{
  const slot = slotWindowInZone('2026-07-02', '10:00:00', '11:00', 'Europe/London');
  assert.strictEqual(slot.start.toISOString(), '2026-07-02T09:00:00.000Z');
  assert.strictEqual(slot.end.toISOString(), '2026-07-02T10:00:00.000Z');
  const karachi = slotWindowInZone('2026-07-02', '10:00', '11:00', 'Asia/Karachi');
  assert.strictEqual(karachi.start.toISOString(), '2026-07-02T05:00:00.000Z');
}
// Missing or invalid inputs: no window (caller reports the leg as unmeasured).
assert.strictEqual(slotWindowInZone(null, '10:00', '11:00', 'Europe/London'), null);
assert.strictEqual(slotWindowInZone('2026-07-02', null, '11:00', 'Europe/London'), null);
assert.strictEqual(slotWindowInZone('2026-07-02', '10:00', '11:00', null), null);
assert.strictEqual(slotWindowInZone('2026-07-02', '10:00', '11:00', 'Mars/Olympus'), null);
assert.strictEqual(slotWindowInZone('2026-07-02', '11:00', '10:00', 'Europe/London'), null);
assert.strictEqual(slotWindowInZone('2026-02-30', '10:00', '11:00', 'Europe/London'), null);

assert.deepStrictEqual(
  classifyArrivalInZone('2026-07-02T08:59:00Z', '2026-07-02', '10:00', '11:00', 'Europe/London'),
  { timing: TIMING.EARLY, minutesLate: 0 }
);
assert.deepStrictEqual(
  classifyArrivalInZone(new Date('2026-07-02T09:00:00Z'), '2026-07-02', '10:00', '11:00', 'Europe/London'),
  { timing: TIMING.ON_TIME, minutesLate: 0 }
);
assert.deepStrictEqual(
  classifyArrivalInZone('2026-07-02T10:00:00Z', '2026-07-02', '10:00', '11:00', 'Europe/London'),
  { timing: TIMING.ON_TIME, minutesLate: 0 }
);
assert.deepStrictEqual(
  classifyArrivalInZone('2026-07-02T10:17:20Z', '2026-07-02', '10:00', '11:00', 'Europe/London'),
  { timing: TIMING.LATE, minutesLate: 18 }
);
assert.strictEqual(classifyArrivalInZone(null, '2026-07-02', '10:00', '11:00', 'Europe/London'), null);
assert.strictEqual(classifyArrivalInZone('nope', '2026-07-02', '10:00', '11:00', 'Europe/London'), null);
assert.strictEqual(classifyArrivalInZone('2026-07-02T10:00:00Z', '2026-07-02', '10:00', '11:00', null), null);

console.log('bookingPunctuality tests passed');

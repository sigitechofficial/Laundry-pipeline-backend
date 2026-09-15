'use strict';

const assert = require('assert');
const {
  TIMING,
  calendarParts,
  classifySlotTiming,
  summarizeOrderPunctuality,
  emptyPunctuality,
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

console.log('bookingPunctuality tests passed');

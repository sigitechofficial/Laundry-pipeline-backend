'use strict';

/**
 * Promotion start / end are UK calendar days, whatever timezone the admin works in.
 * No database needed.   node tests/promotionDates.test.js
 */

const assert = require('assert');
const { businessDayBound, businessDay, businessClock } = require('../services/promotions/promotionTime');

const iso = (d) => d.toISOString();

// Summer (BST, UTC+1): 13 Oct runs 12 Oct 23:00Z → 13 Oct 22:59:59Z
assert.strictEqual(iso(businessDayBound('2026-10-13', 'start')), '2026-10-12T23:00:00.000Z');
assert.strictEqual(iso(businessDayBound('2026-10-15', 'end')), '2026-10-15T22:59:59.000Z');
// Winter (GMT): the day is the UTC day
assert.strictEqual(iso(businessDayBound('2026-12-01', 'start')), '2026-12-01T00:00:00.000Z');
assert.strictEqual(iso(businessDayBound('2026-12-01', 'end')), '2026-12-01T23:59:59.000Z');
// One-day promotion: end is after start
assert.ok(businessDayBound('2026-10-13', 'end') > businessDayBound('2026-10-13', 'start'));

// Older admin builds send a full timestamp: kept as sent
assert.strictEqual(businessDayBound('2026-10-12T19:00:00.000Z', 'start'), '2026-10-12T19:00:00.000Z');
assert.strictEqual(businessDayBound('2026-13-45', 'start'), '2026-13-45', 'an impossible day is left for validation to refuse');
assert.strictEqual(businessDayBound(null, 'start'), null);

// Reading back gives the day the admin picked, in UK time
assert.strictEqual(businessDay(businessDayBound('2026-10-13', 'start')), '2026-10-13');
assert.strictEqual(businessDay(businessDayBound('2026-10-15', 'end')), '2026-10-15');
assert.strictEqual(businessDay('2026-10-15T23:30:00.000Z'), '2026-10-16', '23:30Z in October is already the next UK day');
assert.strictEqual(businessDay(null), null);

// A 24-hour time is that minute in UK time; an end time includes its whole minute.
assert.strictEqual(businessDayBound('2026-11-20T09:00', 'start').toISOString(), '2026-11-20T09:00:00.000Z', 'winter: UK = UTC');
assert.strictEqual(businessDayBound('2026-07-01 09:00', 'start').toISOString(), '2026-07-01T08:00:00.000Z', 'summer: UK = UTC+1');
assert.strictEqual(businessDayBound('2026-11-20T18:30', 'end').toISOString(), '2026-11-20T18:30:59.000Z');
assert.strictEqual(businessDayBound('2026-11-20T25:00', 'start'), '2026-11-20T25:00', 'not a time: left for validation');
assert.strictEqual(businessClock(new Date('2026-07-01T08:00:00Z')), '09:00');
assert.strictEqual(businessClock(null), null);

console.log('promotionDates.test.js passed');

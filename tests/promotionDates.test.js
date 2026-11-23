'use strict';

/**
 * Promotion start / end are calendar days in the promotion's own time zone (the one its
 * zones share), whatever timezone the admin works in. Never an assumed zone.
 * No database needed.   node tests/promotionDates.test.js
 */

const assert = require('assert');
const { businessDayBound, businessDay, businessClock } = require('../services/promotions/promotionTime');

const iso = (d) => d.toISOString();
const LONDON = 'Europe/London';
const KARACHI = 'Asia/Karachi'; // UTC+5, no daylight saving
const NEW_YORK = 'America/New_York';

// Summer (BST, UTC+1): 13 Oct runs 12 Oct 23:00Z → 13 Oct 22:59:59Z
assert.strictEqual(iso(businessDayBound('2026-10-13', 'start', LONDON)), '2026-10-12T23:00:00.000Z');
assert.strictEqual(iso(businessDayBound('2026-10-15', 'end', LONDON)), '2026-10-15T22:59:59.000Z');
// Winter (GMT): the day is the UTC day
assert.strictEqual(iso(businessDayBound('2026-12-01', 'start', LONDON)), '2026-12-01T00:00:00.000Z');
assert.strictEqual(iso(businessDayBound('2026-12-01', 'end', LONDON)), '2026-12-01T23:59:59.000Z');
// One-day promotion: end is after start
assert.ok(businessDayBound('2026-10-13', 'end', LONDON) > businessDayBound('2026-10-13', 'start', LONDON));

// Older admin builds send a full timestamp: kept as sent
assert.strictEqual(businessDayBound('2026-10-12T19:00:00.000Z', 'start', LONDON), '2026-10-12T19:00:00.000Z');
assert.strictEqual(businessDayBound('2026-13-45', 'start', LONDON), '2026-13-45', 'an impossible day is left for validation to refuse');
assert.strictEqual(businessDayBound(null, 'start', LONDON), null);

// Reading back gives the day the admin picked, in UK time
assert.strictEqual(businessDay(businessDayBound('2026-10-13', 'start', LONDON), LONDON), '2026-10-13');
assert.strictEqual(businessDay(businessDayBound('2026-10-15', 'end', LONDON), LONDON), '2026-10-15');
assert.strictEqual(businessDay('2026-10-15T23:30:00.000Z', LONDON), '2026-10-16', '23:30Z in October is already the next UK day');
assert.strictEqual(businessDay(null, LONDON), null);

// A 24-hour time is that minute in UK time; an end time includes its whole minute.
assert.strictEqual(businessDayBound('2026-11-20T09:00', 'start', LONDON).toISOString(), '2026-11-20T09:00:00.000Z', 'winter: UK = UTC');
assert.strictEqual(businessDayBound('2026-07-01 09:00', 'start', LONDON).toISOString(), '2026-07-01T08:00:00.000Z', 'summer: UK = UTC+1');
assert.strictEqual(businessDayBound('2026-11-20T18:30', 'end', LONDON).toISOString(), '2026-11-20T18:30:59.000Z');
assert.strictEqual(businessDayBound('2026-11-20T25:00', 'start', LONDON), '2026-11-20T25:00', 'not a time: left for validation');
assert.strictEqual(businessClock(new Date('2026-07-01T08:00:00Z'), LONDON), '09:00');
assert.strictEqual(businessClock(null, LONDON), null);

// A promotion in a non-UK zone: its days are that zone's days.
assert.strictEqual(iso(businessDayBound('2026-10-13', 'start', KARACHI)), '2026-10-12T19:00:00.000Z');
assert.strictEqual(iso(businessDayBound('2026-10-13', 'end', KARACHI)), '2026-10-13T18:59:59.000Z');
assert.strictEqual(iso(businessDayBound('2026-07-01 09:00', 'start', NEW_YORK)), '2026-07-01T13:00:00.000Z', 'EDT = UTC-4');
assert.strictEqual(businessDay('2026-10-12T19:30:00.000Z', KARACHI), '2026-10-13', 'already the 13th in Karachi');
assert.strictEqual(businessDay('2026-10-12T19:30:00.000Z', LONDON), '2026-10-12', 'still the 12th in London');
assert.strictEqual(businessClock(new Date('2026-07-01T08:00:00Z'), KARACHI), '13:00');

// No zone: a day cannot be placed, so it is refused (never read as London).
assert.throws(() => businessDayBound('2026-10-13', 'start'), /No valid IANA time zone/);
assert.throws(() => businessDayBound('2026-10-13T09:00', 'start', 'Not/AZone'), /No valid IANA time zone/);
assert.throws(() => businessDay('2026-10-12T19:30:00.000Z', null), /No valid IANA time zone/);
assert.strictEqual(businessDayBound('2026-10-12T19:00:00.000Z', 'start'), '2026-10-12T19:00:00.000Z', 'a full timestamp needs no zone');

console.log('promotionDates.test.js passed');

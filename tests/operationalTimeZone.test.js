'use strict';

/**
 * Business times run in the zone the data says (booking, zone → country, shop), never an
 * assumed UK zone, and missing zone data fails clearly (422 TIME_ZONE_UNRESOLVED).
 * Pure: models and Redis are stubbed with in-memory rows, so it runs in CI without
 * config.json.   node tests/operationalTimeZone.test.js
 */

const assert = require('assert');
const Module = require('module');
const moment = require('moment-timezone');

// ─── In-memory data: a UK zone, a Pakistan zone, and misconfigured ones ──────
const COUNTRIES = {
  1: { id: 1, name: 'United Kingdom', shortName: 'GB', ianaTimeZone: 'Europe/London' },
  2: { id: 2, name: 'Pakistan', shortName: 'PK', ianaTimeZone: 'Asia/Karachi' },
  3: { id: 3, name: 'Nowhere', shortName: 'NW', ianaTimeZone: null },
  4: { id: 4, name: 'Typo', shortName: 'TY', ianaTimeZone: 'Asia/Karachy' },
};
const ZONES = {
  10: { id: 10, countryId: 1, status: true },
  20: { id: 20, countryId: 2, status: true },
  30: { id: 30, countryId: 3, status: true },
  40: { id: 40, countryId: null, status: true }, // city without a country
};
const SHOP_ADDRESSES = {
  100: { countryId: 2, zoneId: 20 }, // a Lahore shop
  101: { countryId: null, zoneId: 20 }, // country only through its zone
};
const BOOKINGS = {
  1: { id: 1, operationalTimeZone: 'Asia/Karachi', zoneId: 20 },
  2: { id: 2, operationalTimeZone: null, zoneId: 20 }, // older row: its zone's country decides
  3: { id: 3, operationalTimeZone: null, zoneId: null },
};
let platformWindow = null; // { openTime, closeTime } for every day, every country

const zoneRow = (z) => (z ? { id: z.id, city: z.countryId ? { id: 1, country: COUNTRIES[z.countryId] } : null } : null);
const models = {
  countries: { findByPk: async (id) => COUNTRIES[id] || null },
  zone: {
    findOne: async ({ where }) => zoneRow(ZONES[where.id]),
    findAll: async ({ where }) => Object.values(ZONES)
      .filter((z) => (Array.isArray(where.id) ? where.id.includes(z.id) : z.status === where.status))
      .filter((z) => z.countryId)
      .map(zoneRow),
  },
  addressDb: { findOne: async ({ where }) => SHOP_ADDRESSES[where.userId] || null },
  booking: { findByPk: async (id) => BOOKINGS[id] || null },
  cities: {},
  platformOperationalHours: {
    findOne: async ({ where }) => (platformWindow ? { ...platformWindow, status: true, dayOfWeek: where.dayOfWeek, countryId: where.countryId } : null),
  },
  bussinessWorkingHours: {},
  bussinessInformation: {},
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '../models' || request === '../../models') return models;
  if (request === './agentOnlineStatus') return { isAgentOnline: async () => false };
  return originalLoad.call(this, request, parent, isMain);
};

const {
  TIME_ZONE_UNRESOLVED,
  requireOperationalTimeZone,
  wallClockNow,
  getOrderExpireTime,
  getBookingExpireMoment,
  isBookingAcceptWindowOpen,
} = require('../utils/bookingTimeZone');
const {
  getCountryContextById,
  getCountryContextFromZoneId,
  getCountryContextFromShopUserId,
  resolveBookingOperationalTimeZone,
  bookingWallClockNow,
  getOperationalTimeZones,
  requireShopTimeZone,
} = require('../utils/countryTimeZone');
const { isAgentAcceptExpired } = require('../utils/bookingAgentWindow');
const { isPlatformOpenNow, getWallClockContextForCountry } = require('../utils/shopWorkingHours');
const { resolveAgentTimeZone } = require('../utils/agentTimeZone');
const { getCouponLifecycle, getCouponLifecycleAcrossZones } = require('../utils/couponValidity');

/** Asserts a 422 TIME_ZONE_UNRESOLVED, the clear failure that replaces the London default. */
async function rejectsUnresolved(fn, re, label) {
  await assert.rejects(fn, (err) => {
    assert.strictEqual(err.statusCode, 422, `${label}: 422`);
    assert.strictEqual(err.details?.code, TIME_ZONE_UNRESOLVED, `${label}: code`);
    if (re) assert.match(err.message, re, label);
    return true;
  });
}

(async () => {
  // ─── The validator: a zone from data, or a 422 ───────────────────────────
  assert.strictEqual(requireOperationalTimeZone(' Asia/Karachi '), 'Asia/Karachi');
  for (const missing of [undefined, null, '', '   ', 'Not/AZone']) {
    assert.throws(() => requireOperationalTimeZone(missing), (err) => err.statusCode === 422 && err.details.code === TIME_ZONE_UNRESOLVED);
  }
  assert.throws(() => wallClockNow(), /No valid IANA time zone/, 'no zone: no London wall clock');
  assert.throws(() => getOrderExpireTime(null), /No valid IANA time zone/);

  // ─── Wall clock and accept window in a non-UK zone ────────────────────────
  const karachiNow = wallClockNow('Asia/Karachi');
  assert.strictEqual(karachiNow.timeZone, 'Asia/Karachi');
  assert.strictEqual(karachiNow.date, moment.tz('Asia/Karachi').format('YYYY-MM-DD'));
  const expectHHmm = moment.tz('Asia/Karachi').add(30, 'minutes').format('HH:mm');
  assert.strictEqual(getOrderExpireTime('Asia/Karachi').slice(0, 5), expectHHmm, 'expiry clock on Karachi time');

  // Placed 23:50 in Karachi (18:50Z), expiry clock 00:20 → the next Karachi day, 19:20Z.
  const placed = new Date('2026-11-24T18:50:00Z');
  assert.strictEqual(getBookingExpireMoment(placed, '00:20:00', 'Asia/Karachi').toISOString(), '2026-11-24T19:20:00.000Z');
  // Read as London (the old default) it would have been 00:20 on 25 Nov London = 00:20Z.
  assert.strictEqual(getBookingExpireMoment(placed, '00:20:00', 'Europe/London').toISOString(), '2026-11-25T00:20:00.000Z');
  assert.throws(() => getBookingExpireMoment(placed, '00:20:00'), /No valid IANA time zone/);

  // An expiry clock one minute ago in Tokyo: closed in Tokyo; London would still call it open.
  const start = moment().subtract(5, 'minutes').toDate();
  const tokyoJustPast = moment.tz('Asia/Tokyo').subtract(1, 'minute').format('HH:mm:ss');
  assert.strictEqual(isBookingAcceptWindowOpen(start, tokyoJustPast, 'Asia/Tokyo'), false, 'closed on the booking clock');
  const pending = { bookingStatusId: 1, laundryShopId: null, agentBroadcastHeld: false, createdAt: start, agentVisibleAt: start, orderExpireTime: tokyoJustPast };
  assert.strictEqual(isAgentAcceptExpired(pending, 'Asia/Tokyo'), true);
  assert.throws(() => isAgentAcceptExpired(pending, undefined), /No valid IANA time zone/, 'no zone: refused, not London');

  // ─── Country contexts: from the country row, never a default country ──────
  assert.deepStrictEqual(await getCountryContextFromZoneId(20), { countryId: 2, countryName: 'Pakistan', shortName: 'PK', ianaTimeZone: 'Asia/Karachi' });
  assert.strictEqual((await getCountryContextById(1)).ianaTimeZone, 'Europe/London', 'UK data unchanged');
  assert.strictEqual((await getCountryContextFromShopUserId(100)).ianaTimeZone, 'Asia/Karachi');
  assert.strictEqual((await getCountryContextFromShopUserId(101)).ianaTimeZone, 'Asia/Karachi', 'through the zone');
  await rejectsUnresolved(() => getCountryContextById(null), /No country/, 'no country id');
  await rejectsUnresolved(() => getCountryContextById(99), /does not exist/, 'unknown country');
  await rejectsUnresolved(() => getCountryContextById(3), /country "Nowhere"/, 'country without a zone');
  await rejectsUnresolved(() => getCountryContextById(4), /Asia\/Karachy/, 'country with an invalid zone');
  await rejectsUnresolved(() => getCountryContextFromZoneId(null), /No zone/, 'no zone id');
  await rejectsUnresolved(() => getCountryContextFromZoneId(40), /no city with a country/, 'zone without a country');
  await rejectsUnresolved(() => getCountryContextFromZoneId(30), /Nowhere/, "zone whose country has no zone");
  await rejectsUnresolved(() => getCountryContextFromShopUserId(200), /no shop address/, 'shop without an address');
  assert.strictEqual(await requireShopTimeZone({ countryId: 2 }), 'Asia/Karachi');
  await rejectsUnresolved(() => requireShopTimeZone({}), /no country or zone/, 'shop address without country or zone');

  // ─── A booking's operational zone ─────────────────────────────────────────
  assert.strictEqual(await resolveBookingOperationalTimeZone(BOOKINGS[1]), 'Asia/Karachi', 'stored on the booking');
  assert.strictEqual(await resolveBookingOperationalTimeZone(BOOKINGS[2]), 'Asia/Karachi', "its zone's country");
  await rejectsUnresolved(() => resolveBookingOperationalTimeZone(BOOKINGS[3]), /neither/, 'booking without zone data');
  const stamp = await bookingWallClockNow(1);
  assert.strictEqual(stamp.timeZone, 'Asia/Karachi', 'status stamps on the booking clock');
  assert.strictEqual(stamp.date, moment.tz('Asia/Karachi').format('YYYY-MM-DD'));
  await assert.rejects(() => bookingWallClockNow(999), (err) => err.statusCode === 404);
  await rejectsUnresolved(() => bookingWallClockNow(3), /neither/, 'stamp without zone data');

  // Every active zone's zone (de-duplicated), or the one zone's; a misconfigured one fails.
  assert.deepStrictEqual(await getOperationalTimeZones(20), ['Asia/Karachi']);
  await rejectsUnresolved(() => getOperationalTimeZones(), /zone 30/, 'an active zone without a zone');
  ZONES[30].status = false;
  assert.deepStrictEqual((await getOperationalTimeZones()).sort(), ['Asia/Karachi', 'Europe/London']);
  ZONES[30].status = true;

  // ─── Platform hours: judged on the country's own clock ────────────────────
  // Open for the current Karachi hour only: open in Pakistan, closed in the UK right now.
  const k = moment.tz('Asia/Karachi');
  platformWindow = { openTime: k.format('HH:00:00'), closeTime: k.format('HH:59:59') };
  assert.strictEqual((await getWallClockContextForCountry(2)).tz, 'Asia/Karachi');
  assert.strictEqual(await isPlatformOpenNow(2), true, 'open on Karachi time');
  assert.strictEqual(await isPlatformOpenNow(1), false, 'the same hours are not open on London time');
  await rejectsUnresolved(() => isPlatformOpenNow(3), /Nowhere/, 'platform hours without a zone');

  // ─── Agent app display zone: device, saved, then the shop's — never London ─
  assert.strictEqual(resolveAgentTimeZone({ timeZone: 'Asia/Dubai' }, 'Asia/Karachi', 'Europe/London'), 'Asia/Dubai');
  assert.strictEqual(resolveAgentTimeZone({}, null, 'Asia/Karachi'), 'Asia/Karachi', "the shop's zone");
  assert.strictEqual(resolveAgentTimeZone({}, null, null), null, 'unknown stays unknown');

  // ─── Coupon days: the zone's calendar day ────────────────────────────────
  const todayKarachi = moment.tz('Asia/Karachi').format('YYYY-MM-DD');
  const coupon = { isActive: true, startDate: todayKarachi, expiryDate: todayKarachi };
  assert.strictEqual(getCouponLifecycle(coupon, 'Asia/Karachi'), 'active');
  assert.throws(() => getCouponLifecycle(coupon, null), /No valid IANA time zone/, 'no zone: refused');
  assert.strictEqual(getCouponLifecycle({ isActive: false }, null), 'disabled', 'a switched-off coupon needs no zone');
  const tomorrowKarachi = moment.tz('Asia/Karachi').add(1, 'day').format('YYYY-MM-DD');
  assert.strictEqual(getCouponLifecycle({ isActive: true, startDate: tomorrowKarachi }, 'Asia/Karachi'), 'scheduled');
  assert.strictEqual(
    getCouponLifecycleAcrossZones({ isActive: true, startDate: todayKarachi, expiryDate: todayKarachi }, ['Asia/Karachi']),
    'active'
  );
  assert.throws(() => getCouponLifecycleAcrossZones({ isActive: true }, []), /No valid IANA time zone/, 'no zone at all');

  Module._load = originalLoad;
  console.log('operationalTimeZone.test.js: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

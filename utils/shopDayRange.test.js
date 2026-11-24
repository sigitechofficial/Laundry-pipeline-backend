'use strict';

const assert = require('assert');
const { resolveShopDayRange, MAX_RANGE_DAYS } = require('./shopDayRange');

const LONDON = 'Europe/London';
const KARACHI = 'Asia/Karachi';

// Default = today in the shop's zone, not the server's. 23:30 UTC on 1 Jul is
// already 2 Jul in London (BST) and 04:30 on 2 Jul in Karachi.
{
  const now = new Date('2026-07-01T23:30:00Z');
  const london = resolveShopDayRange({}, LONDON, now);
  assert.strictEqual(london.startDate, '2026-07-02');
  assert.strictEqual(london.endDate, '2026-07-02');
  assert.strictEqual(london.days, 1);
  assert.strictEqual(london.from.toISOString(), '2026-07-01T23:00:00.000Z');
  assert.strictEqual(london.to.toISOString(), '2026-07-02T23:00:00.000Z');
  assert.strictEqual(london.timeZone, LONDON);

  const karachi = resolveShopDayRange({}, KARACHI, now);
  assert.strictEqual(karachi.startDate, '2026-07-02');
  assert.strictEqual(karachi.from.toISOString(), '2026-07-01T19:00:00.000Z');
  assert.strictEqual(karachi.to.toISOString(), '2026-07-02T19:00:00.000Z');
}

// Picked days are shop-local and the end day is included; previous = the same
// number of days just before.
{
  const r = resolveShopDayRange({ startDate: '2026-11-17', endDate: '2026-11-23' }, LONDON);
  assert.strictEqual(r.days, 7);
  assert.strictEqual(r.from.toISOString(), '2026-11-17T00:00:00.000Z');
  assert.strictEqual(r.to.toISOString(), '2026-11-24T00:00:00.000Z');
  assert.strictEqual(r.previous.startDate, '2026-11-10');
  assert.strictEqual(r.previous.endDate, '2026-11-16');
  assert.strictEqual(r.previous.from.toISOString(), '2026-11-10T00:00:00.000Z');
  assert.strictEqual(r.previous.to.toISOString(), r.from.toISOString());
}

// DST: the spring-forward day is 23h long, the autumn one 25h — boundaries are
// still local midnights.
{
  const spring = resolveShopDayRange({ startDate: '2026-03-29', endDate: '2026-03-29' }, LONDON);
  assert.strictEqual(spring.from.toISOString(), '2026-03-29T00:00:00.000Z');
  assert.strictEqual(spring.to.toISOString(), '2026-03-29T23:00:00.000Z');
  assert.strictEqual(spring.previous.startDate, '2026-03-28');

  const autumn = resolveShopDayRange({ startDate: '2026-10-24', endDate: '2026-10-26' }, LONDON);
  assert.strictEqual(autumn.days, 3);
  assert.strictEqual(autumn.from.toISOString(), '2026-10-23T23:00:00.000Z');
  assert.strictEqual(autumn.to.toISOString(), '2026-10-27T00:00:00.000Z');
  assert.strictEqual(autumn.previous.startDate, '2026-10-21');
  assert.strictEqual(autumn.previous.endDate, '2026-10-23');
}

// Bad input is rejected, never silently replaced by today.
const rejects = (query, pattern) =>
  assert.throws(() => resolveShopDayRange(query, LONDON), (err) => {
    assert.strictEqual(err.name, 'ValidationError');
    assert.match(err.message, pattern);
    return true;
  });
rejects({ startDate: '2026-11-01' }, /both startDate and endDate/);
rejects({ endDate: '2026-11-01' }, /both startDate and endDate/);
rejects({ startDate: '2026-02-30', endDate: '2026-03-01' }, /startDate must be a calendar day/);
rejects({ startDate: '01/11/2026', endDate: '2026-11-02' }, /startDate must be a calendar day/);
rejects({ startDate: '2026-11-01', endDate: 'tomorrow' }, /endDate must be a calendar day/);
rejects({ startDate: '2026-11-02', endDate: '2026-11-01' }, /on or before end date/);
rejects({ startDate: '2025-01-01', endDate: '2026-11-01' }, new RegExp(`at most ${MAX_RANGE_DAYS} days`));

// Exactly the ceiling (366 days, both ends included) is allowed.
assert.strictEqual(resolveShopDayRange({ startDate: '2026-01-01', endDate: '2027-01-01' }, LONDON).days, 366);

// A missing or unknown zone is a programming error, not a default.
assert.throws(() => resolveShopDayRange({}, null), /invalid IANA time zone/);
assert.throws(() => resolveShopDayRange({}, 'Mars/Olympus'), /invalid IANA time zone/);

console.log('shopDayRange tests passed');

// Report periods are calendar spans in the shop's zone ending today.
{
  const { resolveShopReportPeriod, reportTrendBuckets } = require('./shopDayRange');
  const now = new Date('2026-11-25T23:30:00Z'); // Wed 25 Nov in London, Thu 26 Nov in Karachi
  const week = resolveShopReportPeriod('week', {}, LONDON, now);
  assert.strictEqual(week.startDate, '2026-11-23'); // Monday
  assert.strictEqual(week.endDate, '2026-11-25');
  assert.strictEqual(week.days, 3);
  assert.strictEqual(week.previous.startDate, '2026-11-20');
  const karachiWeek = resolveShopReportPeriod('week', {}, KARACHI, now);
  assert.strictEqual(karachiWeek.endDate, '2026-11-26');
  const month = resolveShopReportPeriod('month', {}, LONDON, now);
  assert.strictEqual(month.startDate, '2026-11-01');
  const year = resolveShopReportPeriod('year', {}, LONDON, now);
  assert.strictEqual(year.startDate, '2026-01-01');
  assert.throws(() => resolveShopReportPeriod('decade', {}, LONDON, now));
  assert.throws(() => resolveShopReportPeriod('custom', { startDate: '2026-11-01' }, LONDON, now));

  const days = reportTrendBuckets('today', resolveShopReportPeriod('today', {}, LONDON, now), LONDON);
  assert.strictEqual(days.length, 7);
  assert.strictEqual(days[6].label, '25 Nov');
  assert.strictEqual(days[0].label, '19 Nov');
  assert.strictEqual(days[6].to.toISOString(), '2026-11-26T00:00:00.000Z');
  const weeks = reportTrendBuckets('week', week, LONDON);
  assert.strictEqual(weeks[6].label, 'w/c 23 Nov');
  const months = reportTrendBuckets('month', month, LONDON);
  assert.strictEqual(months[6].label, 'Nov 2026');
  assert.strictEqual(months[0].label, 'May 2026');
}
console.log('shopDayRange.test.js: report periods passed');

// shopDays: the agent day tabs (Today / Tomorrow lists, counts, slots) use
// the shop's days, never the server's clock. Production, 24 Nov 21:18 UTC
// (GMT): a London shop is still on 24 Nov; a Karachi device / server is on
// 25 Nov, which put an order delivered on 25 Nov under London's Today.
{
  const { shopDays } = require('./shopDayRange');
  const gmtEvening = new Date('2026-11-24T21:18:00Z');
  assert.deepStrictEqual(shopDays(LONDON, gmtEvening), {
    today: '2026-11-24', tomorrow: '2026-11-25', dayAfter: '2026-11-26', timeZone: LONDON,
  });
  assert.strictEqual(shopDays(KARACHI, gmtEvening).today, '2026-11-25');

  // BST: 23:30 UTC on 1 Jul is already 2 Jul in London while the UTC date is 1 Jul.
  const bstLate = new Date('2026-07-01T23:30:00Z');
  assert.deepStrictEqual(shopDays(LONDON, bstLate), {
    today: '2026-07-02', tomorrow: '2026-07-03', dayAfter: '2026-07-04', timeZone: LONDON,
  });
  // GMT just after UTC midnight: London and UTC agree.
  assert.strictEqual(shopDays(LONDON, new Date('2026-12-01T00:10:00Z')).today, '2026-12-01');
  // Month and year roll over in the shop's zone.
  assert.deepStrictEqual(shopDays(LONDON, new Date('2026-12-30T22:00:00Z')), {
    today: '2026-12-30', tomorrow: '2026-12-31', dayAfter: '2027-01-01', timeZone: LONDON,
  });
  assert.throws(() => shopDays('Nowhere/Typo', gmtEvening));
}

// The agent day tabs and their counts read the shop's days (not moment()).
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../controllers/Agent/agents.js'), 'utf8');
  for (const handler of ['exports.agentBookingFilters', 'exports.getBookingCounts']) {
    const start = src.indexOf(handler);
    assert.ok(start >= 0, handler);
    const body = src.slice(start, src.indexOf('\nexports.', start + 1));
    assert.ok(/shopDays\(await requireShopTimeZone\(/.test(body), `${handler} uses the shop's days`);
    assert.ok(!/moment\(\)\.format\("YYYY-MM-DD"\)/.test(body), `${handler} does not read the server's day`);
  }
}

console.log('shopDayRange: shopDays ok');

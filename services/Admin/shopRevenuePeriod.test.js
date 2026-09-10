"use strict";

const assert = require("assert/strict");
const {
  parsePeriodQuery,
  buildPeriodRange,
  previousPeriodRange,
  pctChange,
  toIsoDate,
} = require("./shopRevenuePeriod");

const now = new Date(2026, 8, 8, 15, 30, 0); // 8 Sep 2026

const today = buildPeriodRange("today", "", "", now);
assert.equal(toIsoDate(today.start), "2026-09-08");
assert.equal(toIsoDate(today.end), "2026-09-08");

const twoDays = buildPeriodRange("last_2_days", "", "", now);
assert.equal(toIsoDate(twoDays.start), "2026-09-07");
assert.equal(toIsoDate(twoDays.end), "2026-09-08");

const week = buildPeriodRange("this_week", "", "", now);
assert.equal(toIsoDate(week.start), "2026-09-02");
assert.equal(toIsoDate(week.end), "2026-09-08");

const last7 = buildPeriodRange("last_7_days", "", "", now);
assert.equal(toIsoDate(last7.start), "2026-09-02");
assert.equal(toIsoDate(last7.end), "2026-09-08");

const last30 = buildPeriodRange("last_30_days", "", "", now);
assert.equal(toIsoDate(last30.start), "2026-08-10");
assert.equal(toIsoDate(last30.end), "2026-09-08");

const month = buildPeriodRange("this_month", "", "", now);
assert.equal(toIsoDate(month.start), "2026-09-01");

const year = buildPeriodRange("this_year", "", "", now);
assert.equal(toIsoDate(year.start), "2026-01-01");

assert.equal(buildPeriodRange("all", "", "", now), null);

const custom = buildPeriodRange("custom", "2026-01-01", "2026-12-31", now);
assert.equal(toIsoDate(custom.start), "2026-01-01");
assert.equal(toIsoDate(custom.end), "2026-12-31");

const swapped = buildPeriodRange("custom", "2026-12-31", "2026-01-01", now);
assert.equal(toIsoDate(swapped.start), "2026-01-01");
assert.equal(toIsoDate(swapped.end), "2026-12-31");

const prev = previousPeriodRange(today);
assert.ok(prev);
assert.equal(toIsoDate(prev.end), "2026-09-07");

assert.equal(pctChange(110, 100), 10);
assert.equal(pctChange(0, 0), 0);
assert.equal(pctChange(20, 0), null);

const parsed = parsePeriodQuery({ period: "bogus" });
assert.equal(parsed.period, "this_month");
assert.equal(parsePeriodQuery({ period: "this_year" }).period, "this_year");
assert.equal(parsePeriodQuery({ period: "last_7_days" }).period, "last_7_days");
assert.equal(parsePeriodQuery({ period: "last_30_days" }).period, "last_30_days");

console.log("shopRevenuePeriod.test.js: all assertions passed");

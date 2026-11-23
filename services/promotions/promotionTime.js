'use strict';

/**
 * Zone-local clock for promotion schedules.
 * Schedules ("weekends", "17:00–20:00") are wall-clock times in the zone's
 * timezone (its country's IANA zone), never the server's. There is no default
 * zone: a missing one is a configuration error (requireOperationalTimeZone).
 */

const moment = require('moment-timezone');
const { requireOperationalTimeZone } = require('../../utils/bookingTimeZone');

/** Normalise a Date / ISO string / epoch into a valid Date, or null. */
function toDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** { day: 0-6 (0=Sunday), hhmm: 'HH:MM' } in the given timezone. */
function localClock(date, timeZone) {
  const m = moment(toDate(date) || new Date()).tz(requireOperationalTimeZone(timeZone, "the zone"));
  return { day: m.day(), hhmm: m.format('HH:mm') };
}

/** 'HH:MM[:SS]' → 'HH:MM', or null when not a valid time. */
function normalizeHHMM(value) {
  if (value == null) return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value).trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Is hhmm inside [start, end]? Supports overnight windows (22:00 → 02:00).
 * Missing bounds mean "no time restriction".
 */
function isWithinWindow(hhmm, start, end) {
  const s = normalizeHHMM(start);
  const e = normalizeHHMM(end);
  if (!s || !e) return true;
  if (s <= e) return hhmm >= s && hhmm <= e;
  return hhmm >= s || hhmm <= e;
}

/** Weekday (0-6) of a date-only or datetime value in the given timezone, or null. */
function localDay(value, timeZone) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return moment.tz(value, 'YYYY-MM-DD', requireOperationalTimeZone(timeZone, "the zone")).day();
  }
  const d = toDate(value);
  return d ? moment(d).tz(requireOperationalTimeZone(timeZone, "the zone")).day() : null;
}

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_TIME = /^\d{4}-\d{2}-\d{2}[ T]([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Promotion start/end are in the promotion's own time zone (promotions.timeZone: the one its
 * zones share), whichever timezone the admin's browser is in. A date-only value becomes the
 * first / last moment of that day there; a date with a 24-hour time ('2026-11-20 09:00' or
 * '2026-11-20T09:00') is that minute there (an end time includes its whole minute). A full
 * timestamp with a zone is kept as sent.
 *
 * @param {string|Date|null} value
 * @param {'start'|'end'} bound
 * @param {string} timeZone the promotion's IANA zone (needed for a day or day-and-time value)
 */
function businessDayBound(value, bound, timeZone) {
  if (typeof value === 'string' && DAY_TIME.test(value.trim())) {
    const tz = requireOperationalTimeZone(timeZone, "the promotion");
    const m = moment.tz(value.trim().replace(' ', 'T'), 'YYYY-MM-DDTHH:mm', true, tz);
    if (!m.isValid()) return value;
    return (bound === 'end' ? m.seconds(59).milliseconds(0) : m.seconds(0).milliseconds(0)).toDate();
  }
  if (typeof value !== 'string' || !DAY_ONLY.test(value.trim())) return value;
  const m = moment.tz(value.trim(), 'YYYY-MM-DD', true, requireOperationalTimeZone(timeZone, "the promotion"));
  if (!m.isValid()) return value;
  return (bound === 'end' ? m.endOf('day').milliseconds(0) : m.startOf('day')).toDate();
}

/** Clock time "HH:mm" (24-hour) of a stored moment in the promotion's zone, or null. */
function businessClock(value, timeZone) {
  const d = toDate(value);
  return d ? moment(d).tz(requireOperationalTimeZone(timeZone, "the promotion")).format('HH:mm') : null;
}

/** The calendar day ('YYYY-MM-DD') a stored moment falls on in the promotion's zone, or null. */
function businessDay(value, timeZone) {
  const d = toDate(value);
  return d ? moment(d).tz(requireOperationalTimeZone(timeZone, "the promotion")).format('YYYY-MM-DD') : null;
}

module.exports = {
  businessDayBound,
  businessDay,
  businessClock,
  toDate,
  localClock,
  normalizeHHMM,
  isWithinWindow,
  localDay,
};

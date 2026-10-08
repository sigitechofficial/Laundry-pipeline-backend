'use strict';

/**
 * Zone-local clock for promotion schedules.
 * Schedules ("weekends", "17:00–20:00") are wall-clock times in the zone's
 * timezone, never the server's. Default is the UK business timezone.
 */

const moment = require('moment-timezone');

const DEFAULT_PROMOTION_TIME_ZONE = 'Europe/London';

function resolveTimeZone(timeZone) {
  if (timeZone && typeof timeZone === 'string' && moment.tz.zone(timeZone.trim())) {
    return timeZone.trim();
  }
  return DEFAULT_PROMOTION_TIME_ZONE;
}

/** Normalise a Date / ISO string / epoch into a valid Date, or null. */
function toDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** { day: 0-6 (0=Sunday), hhmm: 'HH:MM' } in the given timezone. */
function localClock(date, timeZone) {
  const m = moment(toDate(date) || new Date()).tz(resolveTimeZone(timeZone));
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
    return moment.tz(value, 'YYYY-MM-DD', resolveTimeZone(timeZone)).day();
  }
  const d = toDate(value);
  return d ? moment(d).tz(resolveTimeZone(timeZone)).day() : null;
}

module.exports = {
  DEFAULT_PROMOTION_TIME_ZONE,
  resolveTimeZone,
  toDate,
  localClock,
  normalizeHHMM,
  isWithinWindow,
  localDay,
};

'use strict';

const moment = require('moment-timezone');

/**
 * Compare a completed pickup/delivery timestamp against the booked slot.
 * Early = before window start, on_time = inside the window, late = after window end.
 */

const TIMING = Object.freeze({
  EARLY: 'early',
  ON_TIME: 'on_time',
  LATE: 'late',
});

const LABELS = Object.freeze({
  early: 'Early',
  on_time: 'On time',
  late: 'Late',
});

function emptyPunctuality() {
  return {
    pickupsCompleted: 0,
    earlyPickups: 0,
    onTimePickups: 0,
    latePickups: 0,
    deliveriesCompleted: 0,
    earlyDeliveries: 0,
    onTimeDeliveries: 0,
    lateDeliveries: 0,
  };
}

function isUtcMidnight(date) {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

function calendarParts(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
      };
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // DATEONLY values often arrive as UTC midnight. Local getDate() would shift
  // the calendar day west of UTC (e.g. US). Use UTC parts in that case.
  if (isUtcMidnight(date)) {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function parseClock(value, fallback) {
  if (value == null || value === '') return fallback;
  const parts = String(value).trim().split(':');
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  const second = Number(parts[2]);
  return {
    hour: Number.isFinite(hour) ? hour : fallback.hour,
    minute: Number.isFinite(minute) ? minute : fallback.minute,
    second: Number.isFinite(second) ? second : fallback.second,
  };
}

function slotDateTime(dateValue, timeValue, endOfWindow) {
  const parts = calendarParts(dateValue);
  if (!parts) return null;
  const clock = parseClock(
    timeValue,
    endOfWindow
      ? { hour: 23, minute: 59, second: 59 }
      : { hour: 0, minute: 0, second: 0 }
  );
  return new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    clock.hour,
    clock.minute,
    clock.second,
    endOfWindow ? 999 : 0
  );
}

function classifySlotTiming(completedAt, dateValue, timeFrom, timeTo) {
  if (!completedAt || !dateValue) return null;
  const completed = completedAt instanceof Date ? completedAt : new Date(completedAt);
  if (Number.isNaN(completed.getTime())) return null;

  const start = slotDateTime(dateValue, timeFrom, false);
  const end = slotDateTime(dateValue, timeTo, true);
  if (!start || !end) return null;

  const ts = completed.getTime();
  if (ts < start.getTime()) return TIMING.EARLY;
  if (ts > end.getTime()) return TIMING.LATE;
  return TIMING.ON_TIME;
}

const SLOT_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_TIME_PATTERN = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * A booked slot as real instants. The slot's day and HH:mm wall clock are
 * in the zone the slot was offered in (booking.operationalTimeZone), not the
 * server's zone. Returns null when anything needed is missing or invalid —
 * the caller reports such a leg as unmeasured instead of guessing.
 *
 * @param {string} slotDay YYYY-MM-DD (the booking's collection/delivery day)
 * @param {string} timeFrom HH:mm[:ss]
 * @param {string} timeTo HH:mm[:ss]
 * @param {string} timeZone IANA zone
 * @returns {{ start: Date, end: Date } | null}
 */
function slotWindowInZone(slotDay, timeFrom, timeTo, timeZone) {
  if (typeof slotDay !== 'string' || !SLOT_DAY_PATTERN.test(slotDay)) return null;
  if (!timeZone || !moment.tz.zone(String(timeZone))) return null;
  const from = timeFrom == null ? '' : String(timeFrom).trim();
  const to = timeTo == null ? '' : String(timeTo).trim();
  if (!SLOT_TIME_PATTERN.test(from) || !SLOT_TIME_PATTERN.test(to)) return null;

  const at = (clock) =>
    moment.tz(`${slotDay} ${clock.length === 5 ? `${clock}:00` : clock}`, 'YYYY-MM-DD HH:mm:ss', true, timeZone);
  const start = at(from);
  const end = at(to);
  if (!start.isValid() || !end.isValid() || !end.isAfter(start)) return null;
  return { start: start.toDate(), end: end.toDate() };
}

/**
 * Punctuality of a driver's arrival at the door against the booked slot:
 * early = before the slot start, on_time = inside [start, end], late = after
 * the end. minutesLate = whole minutes past the slot end (0 unless late).
 * Null when the arrival or the slot cannot be resolved.
 */
function classifyArrivalInZone(arrivedAt, slotDay, timeFrom, timeTo, timeZone) {
  if (!arrivedAt) return null;
  const arrived = arrivedAt instanceof Date ? arrivedAt : new Date(arrivedAt);
  if (Number.isNaN(arrived.getTime())) return null;
  const slot = slotWindowInZone(slotDay, timeFrom, timeTo, timeZone);
  if (!slot) return null;

  const ts = arrived.getTime();
  if (ts < slot.start.getTime()) return { timing: TIMING.EARLY, minutesLate: 0 };
  if (ts > slot.end.getTime()) {
    return { timing: TIMING.LATE, minutesLate: Math.ceil((ts - slot.end.getTime()) / 60000) };
  }
  return { timing: TIMING.ON_TIME, minutesLate: 0 };
}

function addTiming(summary, kind, timing) {
  if (!timing) return;
  if (kind === 'pickup') {
    summary.pickupsCompleted += 1;
    if (timing === TIMING.EARLY) summary.earlyPickups += 1;
    else if (timing === TIMING.LATE) summary.latePickups += 1;
    else summary.onTimePickups += 1;
    return;
  }
  summary.deliveriesCompleted += 1;
  if (timing === TIMING.EARLY) summary.earlyDeliveries += 1;
  else if (timing === TIMING.LATE) summary.lateDeliveries += 1;
  else summary.onTimeDeliveries += 1;
}

function summarizeOrderPunctuality(orders = []) {
  const summary = emptyPunctuality();
  for (const row of orders) {
    addTiming(summary, 'pickup', row.pickupTiming);
    addTiming(summary, 'delivery', row.deliveryTiming);
  }
  return summary;
}

module.exports = {
  TIMING,
  LABELS,
  emptyPunctuality,
  calendarParts,
  slotDateTime,
  classifySlotTiming,
  slotWindowInZone,
  classifyArrivalInZone,
  addTiming,
  summarizeOrderPunctuality,
};

'use strict';

const moment = require('moment-timezone');
const { ValidationError } = require('../middlewares/universalErrorHandler');

const DAY_FORMAT = 'YYYY-MM-DD';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Same ceiling as the other shop reports (utils/agentReportRange.js). */
const MAX_RANGE_DAYS = 366;

function assertTimeZone(timeZone) {
    if (!timeZone || typeof timeZone !== 'string' || !moment.tz.zone(timeZone)) {
        throw new Error(`resolveShopDayRange: invalid IANA time zone "${timeZone}"`);
    }
}

function parseShopDay(value, field, timeZone) {
    const raw = String(value).trim();
    const day = DAY_PATTERN.test(raw) ? moment.tz(raw, DAY_FORMAT, true, timeZone) : null;
    if (!day || !day.isValid()) {
        throw new ValidationError(`${field} must be a calendar day in YYYY-MM-DD format.`);
    }
    return day.startOf('day');
}

function dayWindow(startDay, days, timeZone) {
    const from = moment.tz(startDay.format(DAY_FORMAT), DAY_FORMAT, true, timeZone).startOf('day');
    const lastDay = from.clone().add(days - 1, 'days');
    // Exclusive end = midnight that starts the day after the last day (DST-safe:
    // calendar arithmetic in the shop's zone, never a fixed 24h * days).
    const to = lastDay.clone().add(1, 'day').startOf('day');
    return {
        startDate: from.format(DAY_FORMAT),
        endDate: lastDay.format(DAY_FORMAT),
        days,
        from: from.toDate(),
        to: to.toDate(),
    };
}

/**
 * Whole calendar days in the shop's own time zone.
 *
 * - No dates: today in the shop's zone.
 * - startDate + endDate (YYYY-MM-DD, shop-local, both days included).
 * - Only one of them, an unparseable day, start after end or more than
 *   MAX_RANGE_DAYS days: ValidationError (never a silent "today").
 *
 * `from` is inclusive and `to` exclusive (UTC instants for SQL:
 * `col >= from AND col < to`). `previous` is the same number of days
 * immediately before startDate.
 *
 * @param {{ startDate?: string, endDate?: string }} query
 * @param {string} timeZone IANA zone of the shop
 * @param {Date} [now]
 */
function resolveShopDayRange(query = {}, timeZone, now = new Date()) {
    assertTimeZone(timeZone);
    const hasStart = query.startDate != null && String(query.startDate).trim() !== '';
    const hasEnd = query.endDate != null && String(query.endDate).trim() !== '';
    if (hasStart !== hasEnd) {
        throw new ValidationError('Send both startDate and endDate, or neither for today.');
    }

    let startDay;
    let endDay;
    if (hasStart) {
        startDay = parseShopDay(query.startDate, 'startDate', timeZone);
        endDay = parseShopDay(query.endDate, 'endDate', timeZone);
        if (startDay.isAfter(endDay)) {
            throw new ValidationError('Start date must be on or before end date.');
        }
    } else {
        startDay = moment.tz(now, timeZone).startOf('day');
        endDay = startDay.clone();
    }

    const days = endDay.diff(startDay, 'days') + 1;
    if (days > MAX_RANGE_DAYS) {
        throw new ValidationError(`The date range can be at most ${MAX_RANGE_DAYS} days.`);
    }

    const current = dayWindow(startDay, days, timeZone);
    const previous = dayWindow(startDay.clone().subtract(days, 'days'), days, timeZone);
    return { timeZone, ...current, previous };
}

module.exports = {
    MAX_RANGE_DAYS,
    resolveShopDayRange,
};

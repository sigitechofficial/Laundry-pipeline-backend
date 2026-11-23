'use strict';

const moment = require('moment-timezone');
const { ValidationError } = require('../middlewares/universalErrorHandler');

const DAY_FORMAT = 'YYYY-MM-DD';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Longest range any shop report accepts. */
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

const REPORT_PERIODS = Object.freeze(['today', 'week', 'month', 'year', 'custom']);

/**
 * Range of a shop report period, in the shop's own time zone:
 * today | week (Monday to today) | month (1st to today) | year (1 Jan to today)
 * | custom (startDate + endDate, see resolveShopDayRange). `previous` is the
 * same number of days immediately before (month-to-date compares with the
 * same number of days before the 1st).
 *
 * @param {string} period
 * @param {{ startDate?: string, endDate?: string }} query
 * @param {string} timeZone IANA zone of the shop
 * @param {Date} [now]
 */
function resolveShopReportPeriod(period, query = {}, timeZone, now = new Date()) {
    assertTimeZone(timeZone);
    if (!REPORT_PERIODS.includes(period)) {
        throw new ValidationError(`Invalid period. Use: ${REPORT_PERIODS.join(', ')}.`);
    }
    if (period === 'custom') {
        const hasBoth = query.startDate && query.endDate;
        if (!hasBoth) throw new ValidationError('Pick a start date and an end date.');
        return { period, ...resolveShopDayRange(query, timeZone, now) };
    }
    const today = moment.tz(now, timeZone).startOf('day');
    const start = {
        today: today.clone(),
        week: today.clone().startOf('isoWeek'),
        month: today.clone().startOf('month'),
        year: today.clone().startOf('year'),
    }[period];
    return {
        period,
        ...resolveShopDayRange(
            { startDate: start.format(DAY_FORMAT), endDate: today.format(DAY_FORMAT) },
            timeZone,
            now,
        ),
    };
}

/**
 * Seven trend buckets ending with the period's last day, in the shop's zone:
 * days for today/custom, Monday-start weeks for week, months for month, years
 * for year. Each bucket: { label, from (inclusive), to (exclusive) }.
 */
function reportTrendBuckets(period, range, timeZone, count = 7) {
    assertTimeZone(timeZone);
    const unit = { today: 'day', custom: 'day', week: 'isoWeek', month: 'month', year: 'year' }[period];
    if (!unit) throw new ValidationError(`Invalid period. Use: ${REPORT_PERIODS.join(', ')}.`);
    const step = unit === 'isoWeek' ? 'week' : unit;
    const label = { day: 'DD MMM', isoWeek: '[w/c] DD MMM', month: 'MMM YYYY', year: 'YYYY' }[unit];
    const last = moment.tz(range.endDate, DAY_FORMAT, true, timeZone).startOf(unit);
    const buckets = [];
    for (let i = count - 1; i >= 0; i -= 1) {
        const from = last.clone().subtract(i, step).startOf(unit);
        const to = from.clone().add(1, step).startOf(unit);
        buckets.push({ label: from.format(label), from: from.toDate(), to: to.toDate() });
    }
    return buckets;
}

module.exports = {
    MAX_RANGE_DAYS,
    REPORT_PERIODS,
    resolveShopDayRange,
    resolveShopReportPeriod,
    reportTrendBuckets,
};

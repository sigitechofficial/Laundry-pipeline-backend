'use strict';

const { ValidationError } = require('../middlewares/universalErrorHandler');

const PERIODS = ['today', 'week', 'month', 'year', 'custom'];

function parseDay(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * Date range for the agent app reports (Earning report, Order summary, Shop
 * performance): today | week (Monday start) | month | year | custom
 * (startDate + endDate, YYYY-MM-DD, both days included, at most a year).
 * The app's "Custom" chip sends period=custom — before this it got a 400.
 */
function resolveAgentReportRange(period, query = {}, now = new Date()) {
    if (!PERIODS.includes(period)) {
        throw new ValidationError('Invalid period. Use: today, week, month, year or custom.');
    }
    const start = new Date(now);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    if (period === 'custom') {
        const from = parseDay(query.startDate);
        const to = parseDay(query.endDate);
        if (!from || !to || from > to) {
            throw new ValidationError('Pick a start date and an end date (start before end).');
        }
        if ((to - from) / 86400000 > 366) {
            throw new ValidationError('The date range can be at most one year.');
        }
        start.setTime(from.getTime());
        end.setTime(to.getTime());
        end.setHours(23, 59, 59, 999);
    } else if (period === 'week') {
        const day = start.getDay();
        start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
    } else if (period === 'month') {
        start.setDate(1);
    } else if (period === 'year') {
        start.setMonth(0, 1);
    }
    start.setHours(0, 0, 0, 0);
    return { start, end };
}

module.exports = { resolveAgentReportRange, AGENT_REPORT_PERIODS: PERIODS };

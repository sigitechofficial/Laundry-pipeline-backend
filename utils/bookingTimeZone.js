const moment = require('moment-timezone');

/** Default IANA zone for UK laundry operations (customer + agent). */
const BUSINESS_TIME_ZONE = 'Europe/London';

/**
 * Single source of truth: accept window for agents (filter, API, DB orderExpireTime clock).
 * Change only this value — e.g. 5 → expiry ~now+5min in DB (22:00 → 22:05).
 */
const BOOKING_ACCEPT_WINDOW_MINUTES = 5;

/**
 * Resolve IANA timezone from app headers/body (timeZone or clientTimeZone).
 * @param {string} [timeZone]
 * @param {string} [clientTimeZone]
 * @returns {string}
 */
function resolveBookingTimeZone(timeZone, clientTimeZone) {
    const candidate = timeZone || clientTimeZone;
    if (candidate && typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (moment.tz.zone(trimmed)) {
            return trimmed;
        }
    }
    return BUSINESS_TIME_ZONE;
}

/**
 * Current wall-clock in the resolved booking timezone.
 * @param {string} [timeZone]
 * @param {string} [clientTimeZone]
 */
function wallClockNow(timeZone, clientTimeZone) {
    const tz = resolveBookingTimeZone(timeZone, clientTimeZone);
    const m = moment.tz(tz);
    return {
        date: m.format('YYYY-MM-DD'),
        time: m.format('HH:mm:ss'),
        timeHHmm: m.format('HH:mm'),
        timeZone: tz,
    };
}

/**
 * DB orderExpireTime: wall-clock when accept window ends (now + BOOKING_ACCEPT_WINDOW_MINUTES).
 * @param {string} [timeZone]
 * @param {string} [clientTimeZone]
 * @param {number} [mins]
 */
function getOrderExpireTime(
    timeZone,
    clientTimeZone,
    mins = BOOKING_ACCEPT_WINDOW_MINUTES
) {
    const tz = resolveBookingTimeZone(timeZone, clientTimeZone);
    return moment.tz(tz).add(mins, 'minutes').format('HH:mm:ss');
}

/**
 * Bookings created after this instant are still inside the agent accept window.
 * Uses BOOKING_ACCEPT_WINDOW_MINUTES — same as getOrderExpireTime.
 * @param {string} [timeZone]
 * @param {string} [clientTimeZone]
 * @param {number} [windowMinutes]
 * @returns {Date}
 */
function getActiveBookingCutoff(
    timeZone,
    clientTimeZone,
    windowMinutes = BOOKING_ACCEPT_WINDOW_MINUTES
) {
    const tz = resolveBookingTimeZone(timeZone, clientTimeZone);
    return moment.tz(tz).subtract(windowMinutes, 'minutes').toDate();
}

module.exports = {
    BUSINESS_TIME_ZONE,
    BOOKING_ACCEPT_WINDOW_MINUTES,
    resolveBookingTimeZone,
    wallClockNow,
    getOrderExpireTime,
    getActiveBookingCutoff,
};

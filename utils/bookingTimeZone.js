const moment = require('moment-timezone');

/** Default IANA zone for UK laundry operations (customer + agent). */
const BUSINESS_TIME_ZONE = 'Europe/London';

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
 * orderExpireTime value (~now + mins) in the same timezone used for agent filtering.
 * @param {number} [mins]
 * @param {string} [timeZone]
 * @param {string} [clientTimeZone]
 */
function getOrderExpireTime(mins = 40, timeZone, clientTimeZone) {
    const tz = resolveBookingTimeZone(timeZone, clientTimeZone);
    return moment.tz(tz).add(mins, 'minutes').format('HH:mm');
}

/**
 * Bookings created after this instant are still inside the agent accept window.
 * Matches getOrderExpireTime (now + 40m) without TIME-column midnight bugs.
 * @param {string} [timeZone]
 * @param {string} [clientTimeZone]
 * @param {number} [windowMinutes]
 * @returns {Date}
 */
function getActiveBookingCutoff(timeZone, clientTimeZone, windowMinutes = 40) {
    const tz = resolveBookingTimeZone(timeZone, clientTimeZone);
    return moment.tz(tz).subtract(windowMinutes, 'minutes').toDate();
}

module.exports = {
    BUSINESS_TIME_ZONE,
    resolveBookingTimeZone,
    wallClockNow,
    getOrderExpireTime,
    getActiveBookingCutoff,
};

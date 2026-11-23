const moment = require('moment-timezone');
const { UnprocessableEntityError } = require('../middlewares/universalErrorHandler');

/**
 * Error code for a business time that cannot be placed in a time zone because
 * the data that owns it (booking, zone -> country, shop address) carries none.
 */
const TIME_ZONE_UNRESOLVED = 'TIME_ZONE_UNRESOLVED';

/**
 * Single source of truth: accept window for agents (filter, API, DB orderExpireTime clock).
 * Change only this value — e.g. 30 → expiry ~now+30min in DB (22:00 → 22:30).
 */
const BOOKING_ACCEPT_WINDOW_MINUTES = 30;

/**
 * How long (minutes) the preferred shop (who last completed a job for this
 * customer) gets exclusive visibility before the booking opens to all shops.
 * Must be less than BOOKING_ACCEPT_WINDOW_MINUTES so the full window stays intact.
 */
const PREFERRED_SHOP_WINDOW_MINUTES = 10;

/**
 * The operational IANA zone for a business time (accept windows, slots, shop
 * hours, status stamps), validated. It must come from data: the booking's
 * operationalTimeZone, its zone's country, or the shop's country. A
 * client-sent timeZone is display-only and is never passed here. There is no
 * default zone: missing or invalid data is a configuration error (422), since
 * computing in another zone would silently move times and days.
 *
 * @param {string} timeZone
 * @param {string} [owner] what the zone belongs to, for the error message
 * @returns {string}
 */
function requireOperationalTimeZone(timeZone, owner = 'operational') {
    const tz = typeof timeZone === 'string' ? timeZone.trim() : '';
    if (!tz || !moment.tz.zone(tz)) {
        throw new UnprocessableEntityError(
            `The ${owner} time zone is not configured (no valid IANA time zone${tz ? `: ${tz}` : ''}).`,
            { code: TIME_ZONE_UNRESOLVED }
        );
    }
    return tz;
}

/**
 * Current wall-clock in the operational time zone.
 * @param {string} timeZone operational IANA zone
 */
function wallClockNow(timeZone) {
    const tz = requireOperationalTimeZone(timeZone);
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
 * @param {string} timeZone operational IANA zone
 * @param {number} [mins]
 */
function getOrderExpireTime(timeZone, mins = BOOKING_ACCEPT_WINDOW_MINUTES) {
    const tz = requireOperationalTimeZone(timeZone);
    return moment.tz(tz).add(mins, 'minutes').format('HH:mm:ss');
}

/**
 * Bookings created after this instant are still inside the agent accept window.
 * Uses BOOKING_ACCEPT_WINDOW_MINUTES — same as getOrderExpireTime.
 * The cutoff is an instant, so it does not depend on any time zone.
 * @param {number} [windowMinutes]
 * @returns {Date}
 */
function getActiveBookingCutoff(windowMinutes = BOOKING_ACCEPT_WINDOW_MINUTES) {
    return moment().subtract(windowMinutes, 'minutes').toDate();
}

function normalizeTimeString(timeValue) {
    if (timeValue == null || timeValue === '') return null;
    const raw = String(timeValue).trim();
    if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
    if (/^\d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
    return null;
}

/**
 * Expiry instant from window-start date (agentVisibleAt or createdAt) + orderExpireTime (TIME).
 * orderExpireTime is wall clock in the booking's operational zone, so that is
 * the zone the day is taken in.
 * @param {string} timeZone the booking's operational IANA zone
 */
function getBookingExpireMoment(windowStartAt, orderExpireTime, timeZone) {
    if (!windowStartAt) return null;
    const tz = requireOperationalTimeZone(timeZone);
    const timeStr = normalizeTimeString(orderExpireTime);
    if (!timeStr) return null;

    const start = moment.tz(windowStartAt, tz);
    let expire = moment.tz(
        `${start.format('YYYY-MM-DD')} ${timeStr}`,
        'YYYY-MM-DD HH:mm:ss',
        tz
    );
    if (expire.isBefore(start)) {
        expire = expire.add(1, 'day');
    }
    return expire;
}

/** Whether agents can still accept (now < DB orderExpireTime on window-start day). */
function isBookingAcceptWindowOpen(windowStartAt, orderExpireTime, timeZone) {
    const expire = getBookingExpireMoment(windowStartAt, orderExpireTime, timeZone);
    if (!expire) return true;
    return moment().isBefore(expire);
}

/** Minutes left until orderExpireTime; used for agent countdown. */
function getAcceptWindowMinutesRemaining(windowStartAt, orderExpireTime, timeZone) {
    const expire = getBookingExpireMoment(windowStartAt, orderExpireTime, timeZone);
    if (!expire) return null;
    return Math.max(0, Math.ceil(expire.diff(moment(), 'minutes', true)));
}

function formatOrderExpireTimeForApi(orderExpireTime) {
    return normalizeTimeString(orderExpireTime);
}

module.exports = {
    TIME_ZONE_UNRESOLVED,
    BOOKING_ACCEPT_WINDOW_MINUTES,
    PREFERRED_SHOP_WINDOW_MINUTES,
    requireOperationalTimeZone,
    wallClockNow,
    getOrderExpireTime,
    getActiveBookingCutoff,
    normalizeTimeString,
    getBookingExpireMoment,
    isBookingAcceptWindowOpen,
    getAcceptWindowMinutesRemaining,
    formatOrderExpireTimeForApi,
};

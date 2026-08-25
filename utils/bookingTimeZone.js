const moment = require('moment-timezone');

/** Default IANA zone for UK laundry operations (customer + agent). */
const BUSINESS_TIME_ZONE = 'Europe/London';

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

function normalizeTimeString(timeValue) {
    if (timeValue == null || timeValue === '') return null;
    const raw = String(timeValue).trim();
    if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
    if (/^\d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
    return null;
}

/**
 * Expiry instant from window-start date (agentVisibleAt or createdAt) + orderExpireTime (TIME).
 */
function getBookingExpireMoment(
    windowStartAt,
    orderExpireTime,
    timeZone,
    clientTimeZone
) {
    const tz = resolveBookingTimeZone(timeZone, clientTimeZone);
    if (!windowStartAt) return null;
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
function isBookingAcceptWindowOpen(
    windowStartAt,
    orderExpireTime,
    timeZone,
    clientTimeZone
) {
    const expire = getBookingExpireMoment(
        windowStartAt,
        orderExpireTime,
        timeZone,
        clientTimeZone
    );
    if (!expire) return true;
    const tz = resolveBookingTimeZone(timeZone, clientTimeZone);
    return moment.tz(tz).isBefore(expire);
}

/** Minutes left until orderExpireTime; used for agent countdown. */
function getAcceptWindowMinutesRemaining(
    windowStartAt,
    orderExpireTime,
    timeZone,
    clientTimeZone
) {
    const expire = getBookingExpireMoment(
        windowStartAt,
        orderExpireTime,
        timeZone,
        clientTimeZone
    );
    const tz = resolveBookingTimeZone(timeZone, clientTimeZone);
    if (!expire) return null;
    return Math.max(0, Math.ceil(expire.diff(moment.tz(tz), 'minutes', true)));
}

function formatOrderExpireTimeForApi(orderExpireTime) {
    return normalizeTimeString(orderExpireTime);
}

module.exports = {
    BUSINESS_TIME_ZONE,
    BOOKING_ACCEPT_WINDOW_MINUTES,
    PREFERRED_SHOP_WINDOW_MINUTES,
    resolveBookingTimeZone,
    wallClockNow,
    getOrderExpireTime,
    getActiveBookingCutoff,
    normalizeTimeString,
    getBookingExpireMoment,
    isBookingAcceptWindowOpen,
    getAcceptWindowMinutesRemaining,
    formatOrderExpireTimeForApi,
};

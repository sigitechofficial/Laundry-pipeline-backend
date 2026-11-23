'use strict';

const momentTz = require('moment-timezone');
const { requireOperationalTimeZone } = require('./bookingTimeZone');

/**
 * Calendar day (YYYY-MM-DD) of a coupon date. Date-only values carry their own
 * day; a full timestamp is read in the given operational zone.
 *
 * @param {string|Date|null} value
 * @param {string} [timeZone] operational IANA zone, needed only for timestamps
 */
function toDateOnly(value, timeZone) {
    if (value == null || value === '') return null;

    if (typeof value === 'string') {
        const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
        if (match) return match[1];
        const parsed = momentTz.tz(value, requireOperationalTimeZone(timeZone));
        return parsed.isValid() ? parsed.format('YYYY-MM-DD') : null;
    }

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        // DATEONLY values arrive as UTC midnight — keep that calendar day.
        if (
            value.getUTCHours() === 0 &&
            value.getUTCMinutes() === 0 &&
            value.getUTCSeconds() === 0
        ) {
            const y = value.getUTCFullYear();
            const m = String(value.getUTCMonth() + 1).padStart(2, '0');
            const d = String(value.getUTCDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }
        return momentTz(value).tz(requireOperationalTimeZone(timeZone)).format('YYYY-MM-DD');
    }

    return null;
}

/** Today's calendar day in the operational zone (the zone's country zone). */
function todayDateOnly(timeZone) {
    return momentTz().tz(requireOperationalTimeZone(timeZone)).format('YYYY-MM-DD');
}

/**
 * Usable today if toggled on and within [startDate, expiryDate] inclusive,
 * where "today" is the calendar day in the zone the coupon is used in.
 *
 * @param {object} coupon
 * @param {string} timeZone operational IANA zone of the booking's zone
 */
function getCouponLifecycle(coupon, timeZone) {
    if (!coupon || !coupon.isActive) return 'disabled';
    const today = todayDateOnly(timeZone);
    const start = toDateOnly(coupon.startDate, timeZone);
    const expiry = toDateOnly(coupon.expiryDate, timeZone);
    if (start && start > today) return 'scheduled';
    if (expiry && expiry < today) return 'expired';
    return 'active';
}

/**
 * Admin status for a coupon used in several zones, each judged on its own
 * calendar day. They agree except near midnight between zones that are in
 * different time zones; then a coupon usable in any of them reads 'active',
 * otherwise 'scheduled' (it still starts somewhere).
 *
 * @param {object} coupon
 * @param {string[]} timeZones the operational zones of the zones it covers
 */
function getCouponLifecycleAcrossZones(coupon, timeZones) {
    if (!coupon || !coupon.isActive) return 'disabled';
    const states = new Set(timeZones.map((tz) => getCouponLifecycle(coupon, tz)));
    if (states.size === 0) {
        // No zone to place "today" in: let the missing zone data surface.
        return getCouponLifecycle(coupon, null);
    }
    if (states.size === 1) return [...states][0];
    return states.has('active') ? 'active' : 'scheduled';
}

module.exports = {
    toDateOnly,
    todayDateOnly,
    getCouponLifecycle,
    getCouponLifecycleAcrossZones,
};

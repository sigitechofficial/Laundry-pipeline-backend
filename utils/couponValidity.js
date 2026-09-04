'use strict';

const momentTz = require('moment-timezone');

const BUSINESS_TZ = 'Europe/London';

function toDateOnly(value) {
    if (value == null || value === '') return null;

    if (typeof value === 'string') {
        const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
        if (match) return match[1];
        const parsed = momentTz.tz(value, BUSINESS_TZ);
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
        return momentTz(value).tz(BUSINESS_TZ).format('YYYY-MM-DD');
    }

    return null;
}

function todayDateOnly() {
    return momentTz().tz(BUSINESS_TZ).format('YYYY-MM-DD');
}

/**
 * Usable today if toggled on and within [startDate, expiryDate] inclusive.
 */
function getCouponLifecycle(coupon, today = todayDateOnly()) {
    if (!coupon || !coupon.isActive) return 'disabled';
    const start = toDateOnly(coupon.startDate);
    const expiry = toDateOnly(coupon.expiryDate);
    if (start && start > today) return 'scheduled';
    if (expiry && expiry < today) return 'expired';
    return 'active';
}

module.exports = {
    BUSINESS_TZ,
    toDateOnly,
    todayDateOnly,
    getCouponLifecycle,
};

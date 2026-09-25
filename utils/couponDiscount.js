'use strict';

/**
 * Enterprise laundry coupon math.
 *
 * Contract:
 * - Eligibility (minOrderAmount) and discount base = laundry merchandise only.
 * - Auth hold / Pay Now stays full prepaid; promo never zeros prepaid.
 * - Checkout only *reserves* the code (discountAmt = 0). Invoice finalize
 *   is authoritative via resolveBookingDiscount().
 * - zoneIds null/[] = all zones; otherwise must include booking.zoneId.
 */

function roundMoney(value) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return 0;
    return parseFloat(n.toFixed(2));
}

/**
 * Normalize coupon.zoneIds / banner.zoneIds payloads to number[].
 * null, [], "", "all" → [] (meaning all zones).
 */
function parseZoneIds(raw) {
    if (raw == null || raw === '' || raw === 'all') return [];
    if (Array.isArray(raw)) {
        return raw
            .map((id) => parseInt(id, 10))
            .filter((id) => Number.isFinite(id) && id > 0);
    }
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed || trimmed === '[]') return [];
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parseZoneIds(parsed);
        } catch (_) {
            /* comma-separated */
        }
        return trimmed
            .split(',')
            .map((id) => parseInt(id.trim(), 10))
            .filter((id) => Number.isFinite(id) && id > 0);
    }
    return [];
}

function couponAppliesToZone(couponData, zoneId) {
    const allowed = parseZoneIds(couponData?.zoneIds);
    if (!allowed.length) return true;
    const z = parseInt(zoneId, 10);
    if (!Number.isFinite(z) || z <= 0) return false;
    return allowed.includes(z);
}

function calcDiscount(couponData, laundryAmount) {
    const orderAmount = roundMoney(laundryAmount);
    if (orderAmount <= 0 || !couponData) return 0;

    const value = parseFloat(couponData.discountValue);
    if (!Number.isFinite(value) || value <= 0) return 0;

    let discountAmt;
    if (couponData.discountType === 'percentage') {
        discountAmt = (value / 100) * orderAmount;
        if (couponData.maxDiscountCap != null && couponData.maxDiscountCap !== '') {
            discountAmt = Math.min(discountAmt, parseFloat(couponData.maxDiscountCap));
        }
    } else {
        discountAmt = value;
    }

    return roundMoney(Math.min(discountAmt, orderAmount));
}

function evaluateCouponAgainstLaundry({
    couponData,
    laundryAmount,
    deferMinOrderWhenLaundryUnknown = false,
} = {}) {
    const laundry = roundMoney(laundryAmount);
    const minRaw = couponData?.minOrderAmount;
    const minOrderAmount =
        minRaw != null && minRaw !== '' && Number.isFinite(parseFloat(minRaw))
            ? roundMoney(minRaw)
            : null;

    if (laundry <= 0 && deferMinOrderWhenLaundryUnknown) {
        return {
            discountAmt: 0,
            laundryAmount: laundry,
            minOrderAmount,
            minOrderMet: minOrderAmount == null,
            minOrderDeferred: true,
            rejected: false,
            rejectReason: null,
        };
    }

    if (minOrderAmount != null && laundry < minOrderAmount) {
        return {
            discountAmt: 0,
            laundryAmount: laundry,
            minOrderAmount,
            minOrderMet: false,
            minOrderDeferred: false,
            rejected: true,
            rejectReason: `Minimum laundry / services total of £${minOrderAmount.toFixed(2)} required for this coupon`,
        };
    }

    return {
        discountAmt: calcDiscount(couponData, laundry),
        laundryAmount: laundry,
        minOrderAmount,
        minOrderMet: true,
        minOrderDeferred: false,
        rejected: false,
        rejectReason: null,
    };
}

const CUSTOMER_RESERVE_MESSAGE =
    'Promo saved. Your discount applies when the invoice is ready after inspection — Pay Now is unchanged.';

module.exports = {
    roundMoney,
    calcDiscount,
    evaluateCouponAgainstLaundry,
    parseZoneIds,
    couponAppliesToZone,
    CUSTOMER_RESERVE_MESSAGE,
};

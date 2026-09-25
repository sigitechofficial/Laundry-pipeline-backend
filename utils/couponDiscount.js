'use strict';

/**
 * Enterprise laundry coupon math.
 *
 * Contract:
 * - Eligibility (minOrderAmount) and discount base = laundry merchandise only
 *   (customer/agent service lines), never zone prepaid (min + service fee + tip).
 * - Auth hold / Pay Now stays full prepaid; promo does not reduce Stripe hold.
 * - Booking may store a provisional discount from a laundry estimate; invoice
 *   finalize is authoritative.
 */

function roundMoney(value) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return 0;
    return parseFloat(n.toFixed(2));
}

/**
 * @param {object} couponData
 * @param {number} laundryAmount - laundry / services subtotal (£)
 * @returns {number}
 */
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

/**
 * Evaluate coupon against a known laundry cart / invoice laundry subtotal.
 *
 * @param {object} options
 * @param {object} options.couponData
 * @param {number} options.laundryAmount
 * @param {boolean} [options.deferMinOrderWhenLaundryUnknown=false] - bags-only
 *   booking with £0 estimate: skip min check and return discount 0 until invoice
 * @returns {{
 *   discountAmt: number,
 *   laundryAmount: number,
 *   minOrderAmount: number|null,
 *   minOrderMet: boolean,
 *   minOrderDeferred: boolean,
 *   rejected: boolean,
 *   rejectReason: string|null
 * }}
 */
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

module.exports = {
    roundMoney,
    calcDiscount,
    evaluateCouponAgainstLaundry,
};

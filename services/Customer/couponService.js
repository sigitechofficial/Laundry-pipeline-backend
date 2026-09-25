'use strict';

const { coupon, couponRedemption } = require('../../models');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');
const { getCouponLifecycle } = require('../../utils/couponValidity');
const {
    calcDiscount,
    evaluateCouponAgainstLaundry,
    roundMoney,
    parseZoneIds,
    couponAppliesToZone,
    CUSTOMER_RESERVE_MESSAGE,
} = require('../../utils/couponDiscount');

/**
 * Enterprise laundry coupons:
 * - Checkout reserves the code only (discountAmt always 0 until invoice)
 * - Invoice finalize is authoritative (laundry subtotal + zone + min order)
 * - Pay Now / Stripe hold never reduced
 */
class CouponService {
    async _loadRedeemableCoupon(code, userId) {
        if (!code || typeof code !== 'string') {
            throw new ValidationError('Coupon code is required');
        }

        const couponData = await coupon.findOne({
            where: { code: code.trim().toUpperCase(), isActive: true },
        });

        if (!couponData) {
            throw new NotFoundError('Coupon code is invalid or inactive');
        }

        const lifecycle = getCouponLifecycle(couponData);
        if (lifecycle === 'scheduled') {
            throw new ValidationError('This coupon is not yet active');
        }
        if (lifecycle === 'expired') {
            throw new ValidationError('This coupon has expired');
        }

        if (couponData.usageLimit !== null && couponData.usedCount >= couponData.usageLimit) {
            throw new ValidationError('This coupon has reached its usage limit');
        }

        if (userId) {
            const userUsageCount = await couponRedemption.count({
                where: { couponId: couponData.id, userId },
            });
            if (userUsageCount >= couponData.perUserLimit) {
                throw new ValidationError(
                    'You have already used this coupon the maximum number of times'
                );
            }
        }

        return couponData;
    }

    _assertZoneAllowed(couponData, zoneId) {
        const allowed = parseZoneIds(couponData.zoneIds);
        if (!allowed.length) return; // all zones
        if (zoneId == null || zoneId === '') {
            throw new ValidationError(
                'This promo is zone-specific. Choose a collection address in a valid zone.'
            );
        }
        if (!couponAppliesToZone(couponData, zoneId)) {
            throw new ValidationError('This promo is not valid for your area / zone');
        }
    }

    /**
     * Checkout / booking: reserve coupon only. Money discount is always £0 here.
     *
     * @param {string} code
     * @param {number} laundryCartAmount - ignored for money; kept for API compat
     * @param {number} userId
     * @param {object} [options]
     * @param {number} [options.zoneId]
     */
    async validateCoupon(code, laundryCartAmount, userId, options = {}) {
        const couponData = await this._loadRedeemableCoupon(code, userId);
        this._assertZoneAllowed(couponData, options.zoneId);

        const laundry = roundMoney(laundryCartAmount);
        const zoneIds = parseZoneIds(couponData.zoneIds);

        return {
            couponId: couponData.id,
            // Invoice-only: never reduce Pay Now / prepaid at checkout.
            discountAmt: 0,
            finalAmount: laundry,
            laundryCartAmount: laundry,
            minOrderAmount:
                couponData.minOrderAmount != null
                    ? roundMoney(couponData.minOrderAmount)
                    : null,
            minOrderDeferred: true,
            appliesAt: 'invoice',
            appliesTo: 'laundry',
            prepaidUnchanged: true,
            zoneScope: zoneIds.length ? 'specific' : 'all',
            zoneIds,
            customerMessage: CUSTOMER_RESERVE_MESSAGE,
            couponData,
        };
    }

    /**
     * Authoritative discount when agent builds / refreshes the invoice.
     */
    async resolveBookingDiscount(
        bookingId,
        laundrySubtotal,
        fallbackDiscount = 0,
        transaction = null,
        zoneId = null
    ) {
        const opts = transaction ? { transaction } : {};
        const redemption = await couponRedemption.findOne({
            where: { bookingId },
            include: [{ model: coupon, as: 'coupon', required: false }],
            ...opts,
        });

        if (!redemption || !redemption.coupon) {
            return roundMoney(fallbackDiscount);
        }

        if (!couponAppliesToZone(redemption.coupon, zoneId)) {
            if (roundMoney(redemption.discountAmt) !== 0) {
                await redemption.update({ discountAmt: 0 }, opts);
            }
            return 0;
        }

        const evaluation = evaluateCouponAgainstLaundry({
            couponData: redemption.coupon,
            laundryAmount: laundrySubtotal,
            deferMinOrderWhenLaundryUnknown: false,
        });

        const discountAmt = evaluation.rejected ? 0 : evaluation.discountAmt;
        const prev = roundMoney(redemption.discountAmt);
        if (prev !== discountAmt) {
            await redemption.update({ discountAmt }, opts);
        }

        return discountAmt;
    }

    async recordRedemption(couponId, userId, bookingId, discountAmt, transaction = null) {
        const opts = transaction ? { transaction } : {};

        await couponRedemption.create(
            {
                couponId,
                userId,
                bookingId,
                discountAmt: roundMoney(discountAmt),
            },
            opts
        );

        await coupon.increment('usedCount', {
            by: 1,
            where: { id: couponId },
            ...opts,
        });
    }
}

module.exports = new CouponService();
module.exports.calcDiscount = calcDiscount;
module.exports.evaluateCouponAgainstLaundry = evaluateCouponAgainstLaundry;
module.exports.parseZoneIds = parseZoneIds;
module.exports.couponAppliesToZone = couponAppliesToZone;
module.exports.CUSTOMER_RESERVE_MESSAGE = CUSTOMER_RESERVE_MESSAGE;

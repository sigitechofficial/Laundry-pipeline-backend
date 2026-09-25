'use strict';

const { coupon, couponRedemption } = require('../../models');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');
const { getCouponLifecycle } = require('../../utils/couponValidity');
const {
    calcDiscount,
    evaluateCouponAgainstLaundry,
    roundMoney,
} = require('../../utils/couponDiscount');

/**
 * Enterprise laundry coupons:
 * - minOrder + discount vs laundry merchandise only (not zone prepaid)
 * - Stripe auth hold / Pay Now never reduced by promo
 * - Invoice finalize re-resolves discount via resolveBookingDiscount()
 */
class CouponService {
    /**
     * Load active coupon + enforce lifecycle / usage limits (no money math).
     */
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

    /**
     * Validate a coupon against laundry cart / services total.
     * Does NOT record redemption — use recordRedemption() after booking create.
     *
     * @param {string} code
     * @param {number} laundryCartAmount - laundry merchandise (£); 0 = unknown/bags-only
     * @param {number} userId
     * @param {object} [options]
     * @param {boolean} [options.deferMinOrderWhenLaundryUnknown=true]
     */
    async validateCoupon(code, laundryCartAmount, userId, options = {}) {
        const deferMinOrderWhenLaundryUnknown =
            options.deferMinOrderWhenLaundryUnknown !== false;

        const couponData = await this._loadRedeemableCoupon(code, userId);

        const laundry = roundMoney(laundryCartAmount);
        const evaluation = evaluateCouponAgainstLaundry({
            couponData,
            laundryAmount: laundry,
            deferMinOrderWhenLaundryUnknown,
        });

        if (evaluation.rejected) {
            throw new ValidationError(evaluation.rejectReason);
        }

        return {
            couponId: couponData.id,
            discountAmt: evaluation.discountAmt,
            // Laundry remaining after discount (preview only — not Pay Now).
            finalAmount: roundMoney(Math.max(0, laundry - evaluation.discountAmt)),
            laundryCartAmount: laundry,
            minOrderAmount: evaluation.minOrderAmount,
            minOrderDeferred: evaluation.minOrderDeferred,
            appliesTo: 'laundry',
            prepaidUnchanged: true,
            couponData,
        };
    }

    /**
     * Authoritative discount for a booking at invoice time (or any laundry refresh).
     * Updates couponRedemptions.discountAmt when a redemption exists.
     *
     * @param {number} bookingId
     * @param {number} laundrySubtotal
     * @param {number} [fallbackDiscount] - billing.discount if no redemption row
     * @param {object} [transaction]
     * @returns {Promise<number>}
     */
    async resolveBookingDiscount(
        bookingId,
        laundrySubtotal,
        fallbackDiscount = 0,
        transaction = null
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

    /**
     * Record a coupon redemption after booking create.
     */
    async recordRedemption(couponId, userId, bookingId, discountAmt, transaction = null) {
        const opts = transaction ? { transaction } : {};

        await couponRedemption.create(
            {
                couponId,
                userId,
                bookingId,
                discountAmt,
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

'use strict';

const { coupon, couponRedemption } = require('../../models');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');
const { getCouponLifecycle } = require('../../utils/couponValidity');

/**
 * Calculate the actual discount amount for a given coupon and order total.
 */
function calcDiscount(couponData, orderAmount) {
    const value = parseFloat(couponData.discountValue);
    let discountAmt;

    if (couponData.discountType === 'percentage') {
        discountAmt = (value / 100) * orderAmount;
        if (couponData.maxDiscountCap) {
            discountAmt = Math.min(discountAmt, parseFloat(couponData.maxDiscountCap));
        }
    } else {
        discountAmt = value;
    }

    // Discount can never exceed the order total
    return parseFloat(Math.min(discountAmt, orderAmount).toFixed(2));
}

class CouponService {
    /**
     * Validate a coupon code against business rules and return discount details.
     * Does NOT record any redemption — use recordRedemption() after booking is created.
     *
     * @param {string} code        - Coupon code entered by the customer
     * @param {number} orderAmount - Pre-discount order total (£)
     * @param {number} userId      - Logged-in customer ID
     * @returns {{ couponId, discountAmt, finalAmount, couponData }}
     */
    async validateCoupon(code, orderAmount, userId) {
        if (!code || typeof code !== 'string') {
            throw new ValidationError('Coupon code is required');
        }
        if (!orderAmount || isNaN(parseFloat(orderAmount)) || parseFloat(orderAmount) <= 0) {
            throw new ValidationError('A valid order amount is required');
        }

        const amount = parseFloat(orderAmount);

        const couponData = await coupon.findOne({
            where: { code: code.trim().toUpperCase(), isActive: true }
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

        // Minimum order check
        if (couponData.minOrderAmount && amount < parseFloat(couponData.minOrderAmount)) {
            throw new ValidationError(
                `Minimum order amount of £${parseFloat(couponData.minOrderAmount).toFixed(2)} required for this coupon`
            );
        }

        // Global usage limit
        if (couponData.usageLimit !== null && couponData.usedCount >= couponData.usageLimit) {
            throw new ValidationError('This coupon has reached its usage limit');
        }

        // Per-user limit
        if (userId) {
            const userUsageCount = await couponRedemption.count({
                where: { couponId: couponData.id, userId }
            });
            if (userUsageCount >= couponData.perUserLimit) {
                throw new ValidationError('You have already used this coupon the maximum number of times');
            }
        }

        const discountAmt = calcDiscount(couponData, amount);
        const finalAmount = parseFloat((amount - discountAmt).toFixed(2));

        return {
            couponId: couponData.id,
            discountAmt,
            finalAmount,
            couponData
        };
    }

    /**
     * Record a coupon redemption after a booking has been successfully created.
     * Also increments usedCount on the coupon.
     * Should be called inside the same DB operation as booking creation.
     *
     * @param {number} couponId    - Coupon ID
     * @param {number} userId      - Customer ID
     * @param {number} bookingId   - Newly created booking ID
     * @param {number} discountAmt - Actual discount applied
     * @param {Object} [transaction] - Optional Sequelize transaction
     */
    async recordRedemption(couponId, userId, bookingId, discountAmt, transaction = null) {
        const opts = transaction ? { transaction } : {};

        await couponRedemption.create({
            couponId,
            userId,
            bookingId,
            discountAmt
        }, opts);

        await coupon.increment('usedCount', {
            by: 1,
            where: { id: couponId },
            ...opts
        });
    }
}

module.exports = new CouponService();

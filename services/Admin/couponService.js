'use strict';

const { coupon, couponRedemption, users, booking } = require('../../models');
const { getCouponLifecycle } = require('../../utils/couponValidity');
const { Op } = require('sequelize');
const {
    ValidationError,
    NotFoundError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');

class AdminCouponService {
    /**
     * Create a new coupon.
     */
    async createCoupon(data) {
        const {
            code,
            description,
            discountType,
            discountValue,
            minOrderAmount,
            maxDiscountCap,
            usageLimit,
            perUserLimit,
            startDate,
            expiryDate,
            isActive
        } = data;

        if (!code || !discountType || discountValue === undefined) {
            throw new ValidationError('code, discountType, and discountValue are required');
        }

        if (!['percentage', 'flat'].includes(discountType)) {
            throw new ValidationError('discountType must be "percentage" or "flat"');
        }

        if (parseFloat(discountValue) <= 0) {
            throw new ValidationError('discountValue must be greater than 0');
        }

        if (discountType === 'percentage' && parseFloat(discountValue) > 100) {
            throw new ValidationError('Percentage discount cannot exceed 100');
        }

        const upperCode = code.trim().toUpperCase();

        const existing = await coupon.findOne({ where: { code: upperCode } });
        if (existing) {
            throw new ConflictError(`Coupon code "${upperCode}" already exists`);
        }

        const newCoupon = await coupon.create({
            code: upperCode,
            description: description || null,
            discountType,
            discountValue: parseFloat(discountValue),
            minOrderAmount: minOrderAmount ? parseFloat(minOrderAmount) : null,
            maxDiscountCap: maxDiscountCap ? parseFloat(maxDiscountCap) : null,
            usageLimit: usageLimit ? parseInt(usageLimit) : null,
            perUserLimit: perUserLimit ? parseInt(perUserLimit) : 1,
            startDate: startDate || null,
            expiryDate: expiryDate || null,
            isActive: isActive !== undefined ? isActive : true
        });

        return {
            message: 'Coupon created successfully',
            data: newCoupon
        };
    }

    /**
     * Get all coupons with usage statistics.
     */
    async getAllCoupons({ page = 1, limit = 20, isActive } = {}) {
        const offset = (parseInt(page) - 1) * parseInt(limit);
        const where = {};

        if (isActive !== undefined) {
            where.isActive = isActive === 'true' || isActive === true;
        }

        const { count, rows } = await coupon.findAndCountAll({
            where,
            order: [['createdAt', 'DESC']],
            limit: parseInt(limit),
            offset
        });

        const data = rows.map((row) => {
            const plain = row.get ? row.get({ plain: true }) : row;
            return {
                ...plain,
                status: getCouponLifecycle(plain),
            };
        });

        return {
            message: 'Coupons fetched successfully',
            data,
            meta: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit))
            }
        };
    }

    /**
     * Get a single coupon with its full redemption history.
     */
    async getCouponById(couponId) {
        const couponData = await coupon.findOne({
            where: { id: couponId },
            include: [
                {
                    model: couponRedemption,
                    as: 'redemptions',
                    attributes: ['id', 'userId', 'bookingId', 'discountAmt', 'createdAt'],
                    include: [
                        {
                            model: users,
                            as: 'user',
                            attributes: ['id', 'firstName', 'lastName', 'email']
                        },
                        {
                            model: booking,
                            as: 'booking',
                            attributes: ['id', 'orderTrackId']
                        }
                    ]
                }
            ]
        });

        if (!couponData) {
            throw new NotFoundError('Coupon not found');
        }

        const plain = couponData.get ? couponData.get({ plain: true }) : couponData;
        return {
            message: 'Coupon details fetched',
            data: {
                ...plain,
                status: getCouponLifecycle(plain),
            }
        };
    }

    /**
     * Update a coupon.
     */
    async updateCoupon(couponId, data) {
        const couponData = await coupon.findByPk(couponId);
        if (!couponData) {
            throw new NotFoundError('Coupon not found');
        }

        const {
            code,
            description,
            discountType,
            discountValue,
            minOrderAmount,
            maxDiscountCap,
            usageLimit,
            perUserLimit,
            startDate,
            expiryDate,
            isActive
        } = data;

        if (code) {
            const upperCode = code.trim().toUpperCase();
            const existing = await coupon.findOne({
                where: { code: upperCode, id: { [Op.ne]: couponId } }
            });
            if (existing) {
                throw new ConflictError(`Coupon code "${upperCode}" already exists`);
            }
            couponData.code = upperCode;
        }

        if (discountType !== undefined) {
            if (!['percentage', 'flat'].includes(discountType)) {
                throw new ValidationError('discountType must be "percentage" or "flat"');
            }
            couponData.discountType = discountType;
        }

        if (discountValue !== undefined) {
            if (parseFloat(discountValue) <= 0) {
                throw new ValidationError('discountValue must be greater than 0');
            }
            couponData.discountValue = parseFloat(discountValue);
        }

        if (description !== undefined) couponData.description = description;
        if (minOrderAmount !== undefined) couponData.minOrderAmount = minOrderAmount ? parseFloat(minOrderAmount) : null;
        if (maxDiscountCap !== undefined) couponData.maxDiscountCap = maxDiscountCap ? parseFloat(maxDiscountCap) : null;
        if (usageLimit !== undefined) couponData.usageLimit = usageLimit ? parseInt(usageLimit) : null;
        if (perUserLimit !== undefined) couponData.perUserLimit = parseInt(perUserLimit);
        if (startDate !== undefined) couponData.startDate = startDate || null;
        if (expiryDate !== undefined) couponData.expiryDate = expiryDate || null;
        if (isActive !== undefined) couponData.isActive = isActive;
        if (data.usedCount !== undefined) {
            const used = parseInt(data.usedCount, 10);
            if (Number.isNaN(used) || used < 0) {
                throw new ValidationError('usedCount cannot be negative');
            }
            couponData.usedCount = used;
        }

        await couponData.save();

        return {
            message: 'Coupon updated successfully',
            data: couponData
        };
    }

    /**
     * Deactivate (soft-delete) a coupon by setting isActive = false.
     */
    async deactivateCoupon(couponId) {
        const couponData = await coupon.findByPk(couponId);
        if (!couponData) {
            throw new NotFoundError('Coupon not found');
        }

        couponData.isActive = false;
        await couponData.save();

        return {
            message: 'Coupon deactivated successfully',
            data: { id: couponData.id, code: couponData.code, isActive: false }
        };
    }

    /**
     * Get coupon usage report — total discount given per coupon.
     */
    async getCouponReport() {
        const coupons = await coupon.findAll({
            attributes: ['id', 'code', 'discountType', 'discountValue', 'usedCount', 'usageLimit', 'isActive'],
            include: [
                {
                    model: couponRedemption,
                    as: 'redemptions',
                    attributes: ['discountAmt']
                }
            ],
            order: [['usedCount', 'DESC']]
        });

        const report = coupons.map(c => {
            const plain = c.toJSON();
            const totalDiscountGiven = plain.redemptions.reduce(
                (sum, r) => sum + parseFloat(r.discountAmt || 0),
                0
            );
            return {
                id: plain.id,
                code: plain.code,
                discountType: plain.discountType,
                discountValue: plain.discountValue,
                usedCount: plain.usedCount,
                usageLimit: plain.usageLimit,
                isActive: plain.isActive,
                totalDiscountGiven: parseFloat(totalDiscountGiven.toFixed(2))
            };
        });

        return {
            message: 'Coupon usage report',
            data: report
        };
    }
}

module.exports = new AdminCouponService();

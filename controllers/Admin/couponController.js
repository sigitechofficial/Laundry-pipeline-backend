'use strict';

const adminCouponService = require('../../services/Admin/couponService');
const ResponseHelper = require('../../utils/responseHelper');
const { StatusCodes } = require('http-status-codes');

/**
 * Create a new coupon.
 * POST /admin/coupon/create
 */
async function createCoupon(req, res) {
    const result = await adminCouponService.createCoupon(req.body);
    return ResponseHelper.success(res, result.message, result.data, StatusCodes.CREATED);
}

/**
 * Get all coupons with optional filters.
 * GET /admin/coupons?page=1&limit=20&isActive=true
 */
async function getAllCoupons(req, res) {
    const result = await adminCouponService.getAllCoupons(req.query);
    return ResponseHelper.success(res, result.message, result.data, StatusCodes.OK, result.meta ? { pagination: result.meta } : {});
}

/**
 * Get single coupon with redemption history.
 * GET /admin/coupon/:id
 */
async function getCouponById(req, res) {
    const result = await adminCouponService.getCouponById(req.params.id);
    return ResponseHelper.success(res, result.message, result.data);
}

/**
 * Update a coupon.
 * PUT /admin/coupon/:id
 */
async function updateCoupon(req, res) {
    const result = await adminCouponService.updateCoupon(req.params.id, req.body);
    return ResponseHelper.success(res, result.message, result.data);
}

/**
 * Deactivate a coupon (soft delete).
 * DELETE /admin/coupon/:id
 */
async function deactivateCoupon(req, res) {
    const result = await adminCouponService.deactivateCoupon(req.params.id);
    return ResponseHelper.success(res, result.message, result.data);
}

/**
 * Get coupon usage/discount report.
 * GET /admin/coupon/report
 */
async function getCouponReport(req, res) {
    const result = await adminCouponService.getCouponReport();
    return ResponseHelper.success(res, result.message, result.data);
}

module.exports = {
    createCoupon,
    getAllCoupons,
    getCouponById,
    updateCoupon,
    deactivateCoupon,
    getCouponReport
};

'use strict';

const reviewReasonCodeService = require('../../services/Admin/reviewReasonCodeService');
const shopReviewAdminService = require('../../services/Admin/shopReviewAdminService');
const ResponseHelper = require('../../utils/responseHelper');

async function getReviewReasonCodes(req, res) {
  const reasons = await reviewReasonCodeService.getAll({
    sentiment: req.query.sentiment,
    activeOnly: req.query.activeOnly === 'true',
  });
  return ResponseHelper.success(
    res,
    'Review reason codes retrieved successfully',
    reasons
  );
}

async function createReviewReasonCode(req, res) {
  const created = await reviewReasonCodeService.create(req.body);
  return ResponseHelper.success(
    res,
    'Review reason code created successfully',
    created
  );
}

async function updateReviewReasonCode(req, res) {
  const updated = await reviewReasonCodeService.update(req.params.id, req.body);
  return ResponseHelper.success(
    res,
    'Review reason code updated successfully',
    updated
  );
}

async function deleteReviewReasonCode(req, res) {
  const result = await reviewReasonCodeService.delete(req.params.id);
  return ResponseHelper.success(res, result.message, result);
}

async function listShopReviews(req, res) {
  const data = await shopReviewAdminService.listReviews(req.query);
  return ResponseHelper.success(res, 'Shop reviews retrieved successfully', data);
}

async function getShopReviewById(req, res) {
  const data = await shopReviewAdminService.getReviewById(req.params.id);
  return ResponseHelper.success(res, 'Shop review retrieved successfully', data);
}

async function hideShopReview(req, res) {
  const adminId = req.user?.id;
  const data = await shopReviewAdminService.hideReview(
    req.params.id,
    adminId,
    req.body?.hiddenReason
  );
  return ResponseHelper.success(res, 'Review hidden successfully', data);
}

async function unhideShopReview(req, res) {
  const data = await shopReviewAdminService.unhideReview(req.params.id);
  return ResponseHelper.success(res, 'Review published successfully', data);
}

module.exports = {
  getReviewReasonCodes,
  createReviewReasonCode,
  updateReviewReasonCode,
  deleteReviewReasonCode,
  listShopReviews,
  getShopReviewById,
  hideShopReview,
  unhideShopReview,
};

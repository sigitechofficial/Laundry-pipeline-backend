'use strict';

const shopReviewService = require('../../services/Customer/shopReviewService');
const ResponseHelper = require('../../utils/responseHelper');

async function getReviewReasonCodes(req, res) {
  const reasons = await shopReviewService.getActiveReasonCodes({
    sentiment: req.query.sentiment,
  });
  return ResponseHelper.success(
    res,
    'Review reason codes retrieved successfully',
    reasons
  );
}

async function getReviewEligibility(req, res) {
  const data = await shopReviewService.getReviewEligibility(
    req.params.bookingId,
    req.user.id
  );
  return ResponseHelper.success(res, 'Review eligibility retrieved', data);
}

async function createShopReview(req, res) {
  const created = await shopReviewService.createReview(req.user.id, req.body);
  return ResponseHelper.success(res, 'Thank you for your review', created, 201);
}

async function getShopReviews(req, res) {
  const data = await shopReviewService.getShopReviews(
    req.params.businessInfoId,
    {
      page: req.query.page,
      limit: req.query.limit,
    }
  );
  return ResponseHelper.success(res, 'Shop reviews retrieved successfully', data);
}

module.exports = {
  getReviewReasonCodes,
  getReviewEligibility,
  createShopReview,
  getShopReviews,
};

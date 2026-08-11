'use strict';

const { Op } = require('sequelize');
const {
  booking,
  shopReview,
  shopReviewReason,
  shopReviewStat,
  reviewReasonCode,
  bussinessInformation,
  users,
  sequelize,
} = require('../../models');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} = require('../../middlewares/universalErrorHandler');
const { refreshShopReviewStats } = require('../shopReviewStatsService');

const COMPLETED_STATUS_IDS = [16, 17];
const COMMENT_MAX = 500;

function allowedSentimentsForRating(rating) {
  if (rating <= 2) return ['negative'];
  if (rating >= 4) return ['positive'];
  return ['positive', 'negative'];
}

class ShopReviewService {
  async getActiveReasonCodes({ sentiment } = {}) {
    const where = { status: true };
    if (sentiment === 'positive' || sentiment === 'negative') {
      where.sentiment = sentiment;
    }
    return reviewReasonCode.findAll({
      where,
      order: [
        ['sentiment', 'ASC'],
        ['sortOrder', 'ASC'],
        ['id', 'ASC'],
      ],
      attributes: ['id', 'code', 'label', 'sentiment', 'sortOrder', 'isOther'],
    });
  }

  async getReviewEligibility(bookingId, customerId) {
    const id = Number(bookingId);
    if (!id) throw new ValidationError('Valid booking ID is required');

    const row = await booking.findByPk(id, {
      attributes: [
        'id',
        'customerId',
        'bookingStatusId',
        'laundryShopId',
        'orderTrackId',
      ],
    });
    if (!row) throw new NotFoundError('Booking not found');
    if (Number(row.customerId) !== Number(customerId)) {
      throw new ForbiddenError('You cannot review this booking');
    }

    const existing = await shopReview.findOne({
      where: { bookingId: id },
      include: [
        {
          model: shopReviewReason,
          as: 'reasons',
          include: [
            {
              model: reviewReasonCode,
              as: 'reasonCode',
              attributes: ['id', 'code', 'label', 'sentiment', 'isOther'],
            },
          ],
        },
      ],
    });

    const completed = COMPLETED_STATUS_IDS.includes(Number(row.bookingStatusId));
    const hasShop = row.laundryShopId != null;
    let businessInfo = null;
    if (hasShop) {
      businessInfo = await bussinessInformation.findOne({
        where: { shopAddressId: row.laundryShopId },
        attributes: ['id', 'shopName'],
      });
    }

    const canReview =
      completed && hasShop && Boolean(businessInfo) && !existing;

    return {
      canReview,
      alreadyReviewed: Boolean(existing),
      completed,
      bookingId: row.id,
      orderTrackId: row.orderTrackId,
      shop: businessInfo
        ? { id: businessInfo.id, shopName: businessInfo.shopName }
        : null,
      review: existing
        ? {
            id: existing.id,
            rating: existing.rating,
            comment: existing.comment,
            visibility: existing.visibility,
            submittedAt: existing.submittedAt,
            reasons: (existing.reasons || []).map((r) => ({
              id: r.reasonCode?.id,
              code: r.reasonCode?.code,
              label: r.reasonCode?.label,
              sentiment: r.reasonCode?.sentiment,
              otherText: r.otherText,
            })),
          }
        : null,
      reasons: {
        forRating1to2: 'negative',
        forRating3: 'positive_and_negative',
        forRating4to5: 'positive',
      },
    };
  }

  async createReview(customerId, body) {
    const bookingId = Number(body.bookingId);
    const rating = Number(body.rating);
    const reasonCodeIds = Array.isArray(body.reasonCodeIds)
      ? [...new Set(body.reasonCodeIds.map(Number).filter(Boolean))]
      : [];
    const otherTexts =
      body.otherTexts && typeof body.otherTexts === 'object'
        ? body.otherTexts
        : {};
    let comment =
      body.comment != null ? String(body.comment).trim() : null;
    if (comment === '') comment = null;
    if (comment && comment.length > COMMENT_MAX) {
      throw new ValidationError(`Comment must be at most ${COMMENT_MAX} characters`);
    }

    if (!bookingId) throw new ValidationError('bookingId is required');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new ValidationError('rating must be an integer from 1 to 5');
    }
    if (reasonCodeIds.length < 1) {
      throw new ValidationError('At least one reason is required');
    }

    const eligibility = await this.getReviewEligibility(bookingId, customerId);
    if (!eligibility.canReview) {
      if (eligibility.alreadyReviewed) {
        throw new ConflictError('This booking has already been reviewed');
      }
      if (!eligibility.completed) {
        throw new ValidationError('You can only review completed orders');
      }
      throw new ValidationError('This order cannot be reviewed yet');
    }

    const allowed = allowedSentimentsForRating(rating);
    const reasons = await reviewReasonCode.findAll({
      where: {
        id: { [Op.in]: reasonCodeIds },
        status: true,
      },
    });
    if (reasons.length !== reasonCodeIds.length) {
      throw new ValidationError('One or more reason codes are invalid or inactive');
    }

    for (const reason of reasons) {
      if (!allowed.includes(reason.sentiment)) {
        throw new ValidationError(
          `Reason "${reason.label}" is not allowed for a ${rating}-star rating`
        );
      }
    }

    const reasonPayloads = reasons.map((reason) => {
      let otherText = null;
      if (reason.isOther) {
        const raw =
          otherTexts[String(reason.id)] ??
          otherTexts[reason.id] ??
          otherTexts[reason.code] ??
          comment;
        otherText = raw != null ? String(raw).trim() : '';
        if (!otherText) {
          throw new ValidationError(
            `Please describe your reason for "${reason.label}"`
          );
        }
        if (otherText.length > COMMENT_MAX) {
          throw new ValidationError(
            `Other text must be at most ${COMMENT_MAX} characters`
          );
        }
      }
      return {
        reasonCodeId: reason.id,
        otherText,
      };
    });

    const row = await booking.findByPk(bookingId, {
      attributes: ['id', 'laundryShopId', 'customerId'],
    });
    const businessInfo = await bussinessInformation.findOne({
      where: { shopAddressId: row.laundryShopId },
      attributes: ['id'],
    });

    const created = await sequelize.transaction(async (transaction) => {
      const review = await shopReview.create(
        {
          bookingId,
          customerId: Number(customerId),
          businessInfoId: businessInfo.id,
          laundryShopId: Number(row.laundryShopId),
          rating,
          comment,
          visibility: 'published',
          submittedAt: new Date(),
        },
        { transaction }
      );

      await shopReviewReason.bulkCreate(
        reasonPayloads.map((p) => ({
          shopReviewId: review.id,
          reasonCodeId: p.reasonCodeId,
          otherText: p.otherText,
        })),
        { transaction }
      );

      await refreshShopReviewStats(businessInfo.id, transaction);
      return review;
    });

    return this.getReviewById(created.id);
  }

  async getReviewById(id) {
    return shopReview.findByPk(id, {
      include: [
        {
          model: shopReviewReason,
          as: 'reasons',
          include: [
            {
              model: reviewReasonCode,
              as: 'reasonCode',
              attributes: ['id', 'code', 'label', 'sentiment', 'isOther'],
            },
          ],
        },
        {
          model: bussinessInformation,
          as: 'shop',
          attributes: ['id', 'shopName'],
        },
      ],
    });
  }

  async getShopReviews(businessInfoId, { page = 1, limit = 20 } = {}) {
    const bizId = Number(businessInfoId);
    if (!bizId) throw new ValidationError('Valid shop ID is required');

    const shop = await bussinessInformation.findByPk(bizId, {
      attributes: ['id', 'shopName'],
    });
    if (!shop) throw new NotFoundError('Shop not found');

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
    const offset = (pageNum - 1) * limitNum;

    const stats = await shopReviewStat.findOne({
      where: { businessInfoId: bizId },
    });

    const { rows, count } = await shopReview.findAndCountAll({
      where: {
        businessInfoId: bizId,
        visibility: 'published',
      },
      include: [
        {
          model: shopReviewReason,
          as: 'reasons',
          include: [
            {
              model: reviewReasonCode,
              as: 'reasonCode',
              attributes: ['id', 'code', 'label', 'sentiment'],
            },
          ],
        },
        {
          model: users,
          as: 'customer',
          attributes: ['id', 'firstName', 'lastName'],
        },
      ],
      order: [['submittedAt', 'DESC']],
      limit: limitNum,
      offset,
    });

    return {
      shop: { id: shop.id, shopName: shop.shopName },
      summary: stats
        ? {
            avgRating: Number(stats.avgRating),
            publishedCount: stats.publishedCount,
            ratingCount: stats.ratingCount,
            histogram: {
              1: stats.rating1,
              2: stats.rating2,
              3: stats.rating3,
              4: stats.rating4,
              5: stats.rating5,
            },
            topPositiveReasonCode: stats.topPositiveReasonCode,
            topNegativeReasonCode: stats.topNegativeReasonCode,
          }
        : {
            avgRating: 0,
            publishedCount: 0,
            ratingCount: 0,
            histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
            topPositiveReasonCode: null,
            topNegativeReasonCode: null,
          },
      reviews: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        submittedAt: r.submittedAt,
        customerName: r.customer
          ? `${r.customer.firstName || ''} ${r.customer.lastName || ''}`.trim()
          : 'Customer',
        reasons: (r.reasons || []).map((x) => ({
          code: x.reasonCode?.code,
          label: x.reasonCode?.label,
          sentiment: x.reasonCode?.sentiment,
          otherText: x.otherText,
        })),
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages: Math.ceil(count / limitNum) || 0,
      },
    };
  }

  async getShopSummaryForAgent(agentUserId) {
    const shop = await bussinessInformation.findOne({
      where: { agentId: agentUserId },
      attributes: ['id', 'shopName'],
    });
    if (!shop) throw new NotFoundError('Shop not found for this agent');

    const data = await this.getShopReviews(shop.id, { page: 1, limit: 10 });
    return {
      shop: data.shop,
      summary: data.summary,
      recentReviews: data.reviews,
    };
  }
}

module.exports = new ShopReviewService();

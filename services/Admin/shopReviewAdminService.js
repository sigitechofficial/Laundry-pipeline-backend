'use strict';

const { Op } = require('sequelize');
const {
  shopReview,
  shopReviewReason,
  reviewReasonCode,
  bussinessInformation,
  users,
  booking,
  sequelize,
} = require('../../models');
const {
  ValidationError,
  NotFoundError,
} = require('../../middlewares/universalErrorHandler');
const { refreshShopReviewStats } = require('../shopReviewStatsService');

class ShopReviewAdminService {
  async listReviews(filters = {}) {
    const {
      page = 1,
      limit = 20,
      visibility,
      rating,
      businessInfoId,
      zoneId,
      search,
      startDate,
      endDate,
      sentiment,
    } = filters;

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
    const offset = (pageNum - 1) * limitNum;

    const where = {};
    if (visibility === 'published' || visibility === 'hidden') {
      where.visibility = visibility;
    }
    if (rating != null && rating !== '') {
      const r = Number(rating);
      if (r >= 1 && r <= 5) where.rating = r;
    }
    if (businessInfoId) {
      where.businessInfoId = Number(businessInfoId);
    }
    if (startDate || endDate) {
      where.submittedAt = {};
      if (startDate) where.submittedAt[Op.gte] = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.submittedAt[Op.lte] = end;
      }
    }

    const include = [
      {
        model: shopReviewReason,
        as: 'reasons',
        required: sentiment === 'positive' || sentiment === 'negative',
        include: [
          {
            model: reviewReasonCode,
            as: 'reasonCode',
            attributes: ['id', 'code', 'label', 'sentiment', 'isOther'],
            where:
              sentiment === 'positive' || sentiment === 'negative'
                ? { sentiment }
                : undefined,
            required: sentiment === 'positive' || sentiment === 'negative',
          },
        ],
      },
      {
        model: bussinessInformation,
        as: 'shop',
        attributes: ['id', 'shopName', 'shopAddressId'],
      },
      {
        model: users,
        as: 'customer',
        attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'countryCode'],
      },
      {
        model: booking,
        as: 'booking',
        attributes: ['id', 'orderTrackId', 'zoneId'],
        where: zoneId ? { zoneId: Number(zoneId) } : undefined,
        required: Boolean(zoneId),
      },
    ];

    if (search && String(search).trim()) {
      const q = `%${String(search).trim()}%`;
      where[Op.or] = [
        { comment: { [Op.like]: q } },
        { '$booking.orderTrackId$': { [Op.like]: q } },
        { '$shop.shopName$': { [Op.like]: q } },
        { '$customer.firstName$': { [Op.like]: q } },
        { '$customer.lastName$': { [Op.like]: q } },
        { '$customer.email$': { [Op.like]: q } },
      ];
    }

    const { rows, count } = await shopReview.findAndCountAll({
      where,
      include,
      order: [['submittedAt', 'DESC']],
      limit: limitNum,
      offset,
      distinct: true,
      subQuery: false,
    });

    return {
      reviews: rows.map((r) => this._serialize(r)),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages: Math.ceil(count / limitNum) || 0,
      },
    };
  }

  async getReviewById(id) {
    const reviewId = Number(id);
    if (!reviewId) throw new ValidationError('Valid review ID is required');

    const row = await shopReview.findByPk(reviewId, {
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
        {
          model: users,
          as: 'customer',
          attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'countryCode'],
        },
        {
          model: users,
          as: 'hiddenByAdmin',
          attributes: ['id', 'firstName', 'lastName', 'email'],
        },
        {
          model: booking,
          as: 'booking',
          attributes: ['id', 'orderTrackId', 'zoneId'],
        },
      ],
    });
    if (!row) throw new NotFoundError('Review not found');
    return this._serialize(row, true);
  }

  async hideReview(id, adminId, hiddenReason) {
    const reviewId = Number(id);
    if (!reviewId) throw new ValidationError('Valid review ID is required');

    const row = await shopReview.findByPk(reviewId);
    if (!row) throw new NotFoundError('Review not found');

    const reason =
      hiddenReason != null ? String(hiddenReason).trim().slice(0, 500) : null;

    await sequelize.transaction(async (transaction) => {
      await row.update(
        {
          visibility: 'hidden',
          hiddenReason: reason,
          hiddenByAdminId: Number(adminId) || null,
          hiddenAt: new Date(),
        },
        { transaction }
      );
      await refreshShopReviewStats(row.businessInfoId, transaction);
    });

    return this.getReviewById(reviewId);
  }

  async unhideReview(id) {
    const reviewId = Number(id);
    if (!reviewId) throw new ValidationError('Valid review ID is required');

    const row = await shopReview.findByPk(reviewId);
    if (!row) throw new NotFoundError('Review not found');

    await sequelize.transaction(async (transaction) => {
      await row.update(
        {
          visibility: 'published',
          hiddenReason: null,
          hiddenByAdminId: null,
          hiddenAt: null,
        },
        { transaction }
      );
      await refreshShopReviewStats(row.businessInfoId, transaction);
    });

    return this.getReviewById(reviewId);
  }

  _serialize(r, detailed = false) {
    const base = {
      id: r.id,
      bookingId: r.bookingId,
      orderTrackId: r.booking?.orderTrackId || null,
      customerId: r.customerId,
      customer: r.customer
        ? {
            id: r.customer.id,
            name: `${r.customer.firstName || ''} ${r.customer.lastName || ''}`.trim(),
            email: r.customer.email,
            phoneNumber: r.customer.phoneNum,
          }
        : null,
      businessInfoId: r.businessInfoId,
      shopName: r.shop?.shopName || null,
      laundryShopId: r.laundryShopId,
      rating: r.rating,
      comment: r.comment,
      visibility: r.visibility,
      submittedAt: r.submittedAt,
      reasons: (r.reasons || []).map((x) => ({
        id: x.reasonCode?.id || x.reasonCodeId,
        code: x.reasonCode?.code,
        label: x.reasonCode?.label,
        sentiment: x.reasonCode?.sentiment,
        otherText: x.otherText,
      })),
    };

    if (detailed) {
      base.hiddenReason = r.hiddenReason;
      base.hiddenAt = r.hiddenAt;
      base.hiddenByAdmin = r.hiddenByAdmin
        ? {
            id: r.hiddenByAdmin.id,
            name: `${r.hiddenByAdmin.firstName || ''} ${r.hiddenByAdmin.lastName || ''}`.trim(),
            email: r.hiddenByAdmin.email,
          }
        : null;
    }

    return base;
  }
}

module.exports = new ShopReviewAdminService();

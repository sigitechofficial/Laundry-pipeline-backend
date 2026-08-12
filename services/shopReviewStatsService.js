'use strict';

const { Op } = require('sequelize');
const {
  shopReview,
  shopReviewReason,
  shopReviewStat,
  reviewReasonCode,
  sequelize,
} = require('../models');

/**
 * Recompute and upsert shopReviewStats for a business from published reviews.
 */
async function refreshShopReviewStats(businessInfoId, transaction) {
  const bizId = Number(businessInfoId);
  if (!bizId) return null;

  const published = await shopReview.findAll({
    where: {
      businessInfoId: bizId,
      visibility: 'published',
    },
    attributes: ['id', 'rating'],
    transaction,
  });

  const hist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of published) {
    const rating = Number(r.rating);
    if (rating >= 1 && rating <= 5) {
      hist[rating] += 1;
      sum += rating;
    }
  }
  const publishedCount = published.length;
  const avgRating =
    publishedCount > 0 ? Math.round((sum / publishedCount) * 100) / 100 : 0;

  const reviewIds = published.map((r) => r.id);
  let topPositiveReasonCode = null;
  let topNegativeReasonCode = null;

  if (reviewIds.length > 0) {
    const reasonRows = await shopReviewReason.findAll({
      where: { shopReviewId: { [Op.in]: reviewIds } },
      include: [
        {
          model: reviewReasonCode,
          as: 'reasonCode',
          attributes: ['code', 'sentiment'],
        },
      ],
      transaction,
    });

    const posCounts = {};
    const negCounts = {};
    for (const row of reasonRows) {
      const code = row.reasonCode?.code;
      const sentiment = row.reasonCode?.sentiment;
      if (!code || !sentiment) continue;
      if (sentiment === 'positive') {
        posCounts[code] = (posCounts[code] || 0) + 1;
      } else if (sentiment === 'negative') {
        negCounts[code] = (negCounts[code] || 0) + 1;
      }
    }

    topPositiveReasonCode = pickTopCode(posCounts);
    topNegativeReasonCode = pickTopCode(negCounts);
  }

  const totalCount = await shopReview.count({
    where: { businessInfoId: bizId },
    transaction,
  });

  const payload = {
    businessInfoId: bizId,
    avgRating,
    ratingCount: totalCount,
    publishedCount,
    rating1: hist[1],
    rating2: hist[2],
    rating3: hist[3],
    rating4: hist[4],
    rating5: hist[5],
    topPositiveReasonCode,
    topNegativeReasonCode,
  };

  const existing = await shopReviewStat.findOne({
    where: { businessInfoId: bizId },
    transaction,
  });

  if (existing) {
    await existing.update(payload, { transaction });
    return existing;
  }
  return shopReviewStat.create(payload, { transaction });
}

function pickTopCode(counts) {
  let best = null;
  let bestN = 0;
  for (const [code, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = code;
      bestN = n;
    }
  }
  return best;
}

module.exports = {
  refreshShopReviewStats,
  sequelize,
};

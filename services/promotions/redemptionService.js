'use strict';

/**
 * Redemption ledger service.
 *
 * State machine: RESERVED → COMMITTED → (RELEASED | REVERSED)
 *
 * Concurrency: Uses SELECT FOR UPDATE to prevent over-redemption
 * of hard-limited promotions.
 */

const {
  promotion: Promotion,
  promotionRedemption: Redemption,
  couponCode: CouponCode,
  orderAdjustment: OrderAdjustment,
  promotionAuditLog: AuditLog,
  sequelize,
} = require('../../models');
const { Op } = require('sequelize');
const { money } = require('./moneyUtils');

const RESERVATION_TTL_MINUTES = 15;

// ─── Reserve ────────────────────────────────────────────────────────────────

/**
 * Reserve a promotion entitlement for a customer.
 * Called during checkout before payment.
 *
 * @param {{ promotionId, customerId, couponCode?, zoneId?, discountAmount?, idempotencyKey? }} params
 * @returns {object} redemption row
 */
async function reserveRedemption({
  promotionId,
  customerId,
  couponCode,
  zoneId,
  discountAmount,
  idempotencyKey,
}) {
  const t = await sequelize.transaction();
  try {
    // Idempotency check
    if (idempotencyKey) {
      const existing = await Redemption.findOne({
        where: { idempotencyKey },
        transaction: t,
      });
      if (existing) {
        await t.commit();
        return existing;
      }
    }

    // Lock promotion row for atomic counter check
    const [promos] = await sequelize.query(
      'SELECT * FROM promotions WHERE id = ? FOR UPDATE',
      { replacements: [promotionId], transaction: t, type: sequelize.QueryTypes.SELECT }
    );
    const promo = Array.isArray(promos) ? promos[0] : promos;
    if (!promo) {
      await t.rollback();
      throw new Error('Promotion not found');
    }

    // Check global limit
    if (promo.globalUsageLimit != null) {
      const total = (promo.globalUsedCount || 0) + (promo.globalReservedCount || 0);
      if (total >= promo.globalUsageLimit) {
        await t.rollback();
        throw new Error('PROMOTION_USAGE_EXHAUSTED');
      }
    }

    // Check per-customer limit
    if (promo.perCustomerLimit != null) {
      const customerUsage = await Redemption.count({
        where: {
          promotionId,
          customerId,
          status: { [Op.in]: ['RESERVED', 'COMMITTED'] },
        },
        transaction: t,
      });
      if (customerUsage >= promo.perCustomerLimit) {
        await t.rollback();
        throw new Error('PROMOTION_PER_CUSTOMER_LIMIT');
      }
    }

    // Find coupon code row if applicable
    let couponCodeId = null;
    if (couponCode) {
      const cc = await CouponCode.findOne({
        where: { code: couponCode.toUpperCase(), promotionId, isActive: true },
        transaction: t,
      });
      if (cc) {
        couponCodeId = cc.id;
        // Check coupon-level limit
        if (cc.usageLimit != null && cc.usedCount >= cc.usageLimit) {
          await t.rollback();
          throw new Error('COUPON_USAGE_EXHAUSTED');
        }
      }
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MINUTES * 60 * 1000);

    // Create reservation
    const redemption = await Redemption.create({
      promotionId,
      promotionVersionId: promo.currentVersionId || null,
      couponCodeId,
      couponCode: couponCode || null,
      customerId,
      status: 'RESERVED',
      discountAmount: discountAmount || null,
      currency: promo.currency || 'GBP',
      zoneId: zoneId || null,
      idempotencyKey: idempotencyKey || null,
      reservedAt: now,
      reservationExpiresAt: expiresAt,
    }, { transaction: t });

    // Increment reserved counter
    await sequelize.query(
      'UPDATE promotions SET globalReservedCount = globalReservedCount + 1 WHERE id = ?',
      { replacements: [promotionId], transaction: t }
    );

    await t.commit();
    return redemption;
  } catch (err) {
    if (t.finished !== 'commit') await t.rollback();
    throw err;
  }
}

// ─── Commit ─────────────────────────────────────────────────────────────────

/**
 * Commit a reservation after successful payment/order creation.
 *
 * @param {number} redemptionId
 * @param {number} bookingId
 * @param {number} finalDiscountAmount — actual discount applied
 */
async function commitRedemption(redemptionId, bookingId, finalDiscountAmount) {
  const t = await sequelize.transaction();
  try {
    const redemption = await Redemption.findByPk(redemptionId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!redemption) throw new Error('Redemption not found');
    if (redemption.status !== 'RESERVED') throw new Error(`Cannot commit from status "${redemption.status}"`);

    await redemption.update({
      status: 'COMMITTED',
      bookingId,
      discountAmount: finalDiscountAmount || redemption.discountAmount,
      committedAt: new Date(),
    }, { transaction: t });

    // Move from reserved to used
    await sequelize.query(
      'UPDATE promotions SET globalReservedCount = GREATEST(0, globalReservedCount - 1), globalUsedCount = globalUsedCount + 1 WHERE id = ?',
      { replacements: [redemption.promotionId], transaction: t }
    );

    // Increment coupon used count
    if (redemption.couponCodeId) {
      await sequelize.query(
        'UPDATE coupon_codes SET usedCount = usedCount + 1 WHERE id = ?',
        { replacements: [redemption.couponCodeId], transaction: t }
      );
    }

    await t.commit();
    return redemption.reload();
  } catch (err) {
    if (t.finished !== 'commit') await t.rollback();
    throw err;
  }
}

// ─── Release (timeout / abandoned checkout) ─────────────────────────────────

async function releaseRedemption(redemptionId, reason) {
  const t = await sequelize.transaction();
  try {
    const redemption = await Redemption.findByPk(redemptionId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!redemption) throw new Error('Redemption not found');
    if (redemption.status !== 'RESERVED') throw new Error(`Cannot release from status "${redemption.status}"`);

    await redemption.update({
      status: 'RELEASED',
      releasedAt: new Date(),
      reason: reason || 'Released',
    }, { transaction: t });

    await sequelize.query(
      'UPDATE promotions SET globalReservedCount = GREATEST(0, globalReservedCount - 1) WHERE id = ?',
      { replacements: [redemption.promotionId], transaction: t }
    );

    await t.commit();
    return redemption.reload();
  } catch (err) {
    if (t.finished !== 'commit') await t.rollback();
    throw err;
  }
}

// ─── Reverse (refund / cancellation) ────────────────────────────────────────

async function reverseRedemption(redemptionId, reason) {
  const t = await sequelize.transaction();
  try {
    const redemption = await Redemption.findByPk(redemptionId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!redemption) throw new Error('Redemption not found');
    if (redemption.status !== 'COMMITTED') throw new Error(`Cannot reverse from status "${redemption.status}"`);

    await redemption.update({
      status: 'REVERSED',
      reversedAt: new Date(),
      reason: reason || 'Reversed',
    }, { transaction: t });

    // Decrement usage
    await sequelize.query(
      'UPDATE promotions SET globalUsedCount = GREATEST(0, globalUsedCount - 1) WHERE id = ?',
      { replacements: [redemption.promotionId], transaction: t }
    );

    // Decrement coupon count
    if (redemption.couponCodeId) {
      await sequelize.query(
        'UPDATE coupon_codes SET usedCount = GREATEST(0, usedCount - 1) WHERE id = ?',
        { replacements: [redemption.couponCodeId], transaction: t }
      );
    }

    await t.commit();
    return redemption.reload();
  } catch (err) {
    if (t.finished !== 'commit') await t.rollback();
    throw err;
  }
}

// ─── Cleanup expired reservations ───────────────────────────────────────────

async function cleanupExpiredReservations() {
  const now = new Date();
  const expired = await Redemption.findAll({
    where: {
      status: 'RESERVED',
      reservationExpiresAt: { [Op.lt]: now },
    },
  });

  let cleaned = 0;
  for (const r of expired) {
    try {
      await releaseRedemption(r.id, 'Reservation expired');
      cleaned++;
    } catch (err) {
      console.warn(`[RedemptionCleanup] Failed to release ${r.id}:`, err.message);
    }
  }

  return { cleaned, total: expired.length };
}

// ─── Create order adjustments from engine result ────────────────────────────

/**
 * Write adjustments to the order_adjustments table after promotion evaluation.
 *
 * @param {number} bookingId
 * @param {Array} appliedPromotions — from promotionEngine.evaluatePromotions().applied
 * @returns {Array} created adjustment rows
 */
async function writeOrderAdjustments(bookingId, appliedPromotions) {
  const rows = [];
  for (const promo of appliedPromotions) {
    for (const adj of promo.adjustments) {
      const row = await OrderAdjustment.create({
        bookingId,
        adjustmentClass: classifyAdjustment(promo.benefitType, adj.lineType),
        promotionId: promo.promotionId,
        promotionVersionId: null,
        couponCode: promo.couponCode || null,
        lineType: adj.lineType || 'basket',
        lineItemId: adj.lineItemId || null,
        lineDescription: adj.lineDescription || null,
        amount: money(adj.amount),
        currency: 'GBP',
        label: adj.label || promo.promotionName,
        description: adj.description || null,
        appliedBy: 'system',
      });
      rows.push(row);
    }
  }
  return rows;
}

function classifyAdjustment(benefitType, lineType) {
  if (lineType === 'delivery') return 'DELIVERY_PROMOTION';
  if (['item_discount', 'category_discount', 'service_discount'].includes(benefitType)) return 'ITEM_PROMOTION';
  return 'BASKET_PROMOTION';
}

module.exports = {
  reserveRedemption,
  commitRedemption,
  releaseRedemption,
  reverseRedemption,
  cleanupExpiredReservations,
  writeOrderAdjustments,
};

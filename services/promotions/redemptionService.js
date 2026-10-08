'use strict';

/**
 * Redemption ledger service.
 *
 * State machine: RESERVED → COMMITTED → REVERSED, or RESERVED → RELEASED
 *
 * Concurrency: the promotion row (and coupon row, when a code is used) is locked
 * with SELECT … FOR UPDATE, and limits count reserved + committed entitlements,
 * so concurrent checkouts cannot exceed a hard limit.
 */

const {
  promotionRedemption: Redemption,
  orderAdjustment: OrderAdjustment,
  booking: Booking,
  sequelize,
} = require('../../models');
const { Op } = require('sequelize');
const { money } = require('./moneyUtils');
const { CANCELLED, REFUNDED } = require('../../constants/bookingStatusIds');

const RESERVATION_TTL_MINUTES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A reservation made with a booking is held until the invoice is paid (commit) or the
 * booking is cancelled (release). Booking → invoice takes days, so 15 minutes is far too
 * short; this long expiry keeps every existing "expires > now" check working.
 */
const BOOKING_HOLD_DAYS = 60;
const CLOSED_BOOKING_STATUSES = [CANCELLED, REFUNDED];

/** Idempotency key for a booking's reservation of one promotion (retries never double-reserve). */
const bookingReservationKey = (bookingId, promotionId) => `booking-${bookingId}-promo-${promotionId}`;

class RedemptionError extends Error {
  constructor(code, message) {
    super(code);
    this.code = code;
    this.userMessage = message || code;
  }
}

/** Run fn inside a managed transaction (commits on success, rolls back exactly once on error). */
function inTransaction(fn, outer) {
  if (outer) return fn(outer);
  return sequelize.transaction((t) => fn(t));
}

const activeEntitlementWhere = (now) => ({
  [Op.or]: [
    { status: 'COMMITTED' },
    { status: 'RESERVED', reservationExpiresAt: { [Op.gt]: now } },
  ],
});

/** Committed discounts consume the promotion's campaign budget (reversals give it back). */
async function adjustCampaignBudget(promotionId, discountAmount, t) {
  const minor = Math.round(Number(discountAmount || 0) * 100);
  if (!minor) return;
  await sequelize.query(
    `UPDATE campaigns c JOIN promotions p ON p.campaignId = c.id
     SET c.usedBudgetMinor = GREATEST(0, COALESCE(c.usedBudgetMinor, 0) + ?) WHERE p.id = ?`,
    { replacements: [minor, promotionId], transaction: t }
  );
}

// ─── Reserve ────────────────────────────────────────────────────────────────

/**
 * Reserve a promotion entitlement for a customer. Called during checkout before payment.
 *
 * @param {{ promotionId, customerId, couponCode?, zoneId?, discountAmount?, idempotencyKey? }} params
 * @param {object} [transaction] join an outer transaction (e.g. booking creation)
 * @returns {object} redemption row
 * @throws {RedemptionError} code: PROMOTION_NOT_FOUND | PROMOTION_NOT_ACTIVE | PROMOTION_USAGE_EXHAUSTED |
 *   PROMOTION_PER_CUSTOMER_LIMIT | PROMOTION_DAILY_LIMIT | PROMOTION_WEEKLY_LIMIT | COUPON_INVALID |
 *   COUPON_EXPIRED | COUPON_USAGE_EXHAUSTED | COUPON_ALREADY_USED | COUPON_NOT_YOUR_CODE
 */
async function reserveRedemption(params, transaction) {
  const { promotionId, customerId, couponCode, zoneId, discountAmount, idempotencyKey, bookingId } = params;
  return inTransaction(async (t) => {
    if (idempotencyKey) {
      const existing = await Redemption.findOne({ where: { idempotencyKey }, transaction: t });
      if (existing) return existing;
    }

    const now = new Date();
    const [promo] = await sequelize.query('SELECT * FROM promotions WHERE id = ? FOR UPDATE', {
      replacements: [promotionId], transaction: t, type: sequelize.QueryTypes.SELECT,
    });
    if (!promo) throw new RedemptionError('PROMOTION_NOT_FOUND', 'Promotion not found');
    const live = promo.status === 'active'
      && (!promo.startDate || new Date(promo.startDate) <= now)
      && (!promo.endDate || new Date(promo.endDate) >= now);
    if (!live) throw new RedemptionError('PROMOTION_NOT_ACTIVE', 'This offer is no longer available');
    if (promo.campaignId) {
      const [camp] = await sequelize.query('SELECT status, budgetMinor, usedBudgetMinor FROM campaigns WHERE id = ?', {
        replacements: [promo.campaignId], transaction: t, type: sequelize.QueryTypes.SELECT,
      });
      if (camp && ['paused', 'completed', 'archived'].includes(camp.status)) {
        throw new RedemptionError('PROMOTION_NOT_ACTIVE', 'This offer is no longer available');
      }
      if (camp && camp.budgetMinor != null && Number(camp.usedBudgetMinor || 0) >= Number(camp.budgetMinor)) {
        throw new RedemptionError('PROMOTION_BUDGET_EXHAUSTED', 'This offer is no longer available');
      }
    }

    if (promo.globalUsageLimit != null && (promo.globalUsedCount || 0) + (promo.globalReservedCount || 0) >= promo.globalUsageLimit) {
      throw new RedemptionError('PROMOTION_USAGE_EXHAUSTED', 'This offer has been fully redeemed');
    }

    if (customerId && (promo.perCustomerLimit != null || promo.perDayLimit != null || promo.perWeekLimit != null)) {
      const mine = await Redemption.findAll({
        where: { promotionId, customerId, ...activeEntitlementWhere(now) },
        attributes: ['reservedAt', 'committedAt', 'createdAt'],
        transaction: t,
      });
      const age = (r) => now.getTime() - new Date(r.committedAt || r.reservedAt || r.createdAt).getTime();
      if (promo.perCustomerLimit != null && mine.length >= promo.perCustomerLimit) {
        throw new RedemptionError('PROMOTION_PER_CUSTOMER_LIMIT', 'You have already used this offer');
      }
      if (promo.perDayLimit != null && mine.filter((r) => age(r) < DAY_MS).length >= promo.perDayLimit) {
        throw new RedemptionError('PROMOTION_DAILY_LIMIT', 'Daily limit for this offer reached');
      }
      if (promo.perWeekLimit != null && mine.filter((r) => age(r) < 7 * DAY_MS).length >= promo.perWeekLimit) {
        throw new RedemptionError('PROMOTION_WEEKLY_LIMIT', 'Weekly limit for this offer reached');
      }
    }

    let couponCodeId = null;
    let normalizedCode = null;
    if (couponCode != null && String(couponCode).trim()) {
      normalizedCode = String(couponCode).trim().toUpperCase();
      const [cc] = await sequelize.query('SELECT * FROM coupon_codes WHERE code = ? AND promotionId = ? FOR UPDATE', {
        replacements: [normalizedCode, promotionId], transaction: t, type: sequelize.QueryTypes.SELECT,
      });
      if (!cc || !cc.isActive) throw new RedemptionError('COUPON_INVALID', 'Coupon code is not valid for this offer');
      if (cc.activationDate && new Date(cc.activationDate) > now) throw new RedemptionError('COUPON_INVALID', 'Coupon is not active yet');
      if (cc.expiryDate && new Date(cc.expiryDate) < now) throw new RedemptionError('COUPON_EXPIRED', 'Coupon has expired');
      if (cc.codeType === 'customer_bound' && cc.customerId && Number(cc.customerId) !== Number(customerId)) {
        throw new RedemptionError('COUPON_NOT_YOUR_CODE', 'This coupon is assigned to another customer');
      }
      if (cc.usageLimit != null) {
        const reserved = await Redemption.count({
          where: { couponCodeId: cc.id, status: 'RESERVED', reservationExpiresAt: { [Op.gt]: now } },
          transaction: t,
        });
        if ((cc.usedCount || 0) + reserved >= cc.usageLimit) {
          throw new RedemptionError('COUPON_USAGE_EXHAUSTED', 'Coupon has been fully redeemed');
        }
      }
      if (cc.perCustomerLimit != null && customerId) {
        const mine = await Redemption.count({
          where: { couponCodeId: cc.id, customerId, ...activeEntitlementWhere(now) },
          transaction: t,
        });
        if (mine >= cc.perCustomerLimit) throw new RedemptionError('COUPON_ALREADY_USED', 'You have already used this coupon');
      }
      couponCodeId = cc.id;
    } else if (promo.activationType === 'coupon_required') {
      throw new RedemptionError('COUPON_INVALID', 'A coupon code is required for this offer');
    }

    const redemption = await Redemption.create({
      promotionId,
      promotionVersionId: promo.currentVersionId || null,
      couponCodeId,
      couponCode: normalizedCode,
      customerId,
      bookingId: bookingId || null,
      status: 'RESERVED',
      discountAmount: discountAmount != null ? money(discountAmount) : null,
      currency: promo.currency || 'GBP',
      zoneId: zoneId || null,
      idempotencyKey: idempotencyKey || null,
      reservedAt: now,
      reservationExpiresAt: bookingId
        ? new Date(now.getTime() + BOOKING_HOLD_DAYS * DAY_MS)
        : new Date(now.getTime() + RESERVATION_TTL_MINUTES * 60 * 1000),
    }, { transaction: t });

    await sequelize.query('UPDATE promotions SET globalReservedCount = globalReservedCount + 1 WHERE id = ?', {
      replacements: [promotionId], transaction: t,
    });

    return redemption;
  }, transaction);
}

// ─── Commit ─────────────────────────────────────────────────────────────────

/**
 * Commit a reservation after successful payment/order creation.
 * Works until the cleanup job releases the reservation (it still holds its counter until then).
 *
 * @param {number} redemptionId
 * @param {number} bookingId
 * @param {number} finalDiscountAmount — actual discount applied
 * @param {object} [transaction]
 */
async function commitRedemption(redemptionId, bookingId, finalDiscountAmount, transaction) {
  return inTransaction(async (t) => {
    const redemption = await Redemption.findByPk(redemptionId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!redemption) throw new RedemptionError('REDEMPTION_NOT_FOUND');
    if (redemption.status === 'COMMITTED' && (bookingId == null || Number(redemption.bookingId) === Number(bookingId))) {
      return redemption; // idempotent retry
    }
    if (redemption.status !== 'RESERVED') throw new RedemptionError('REDEMPTION_INVALID_STATE', `Cannot commit from status "${redemption.status}"`);

    await redemption.update({
      status: 'COMMITTED',
      bookingId: bookingId ?? redemption.bookingId,
      discountAmount: finalDiscountAmount != null ? money(finalDiscountAmount) : redemption.discountAmount,
      committedAt: new Date(),
    }, { transaction: t });

    await sequelize.query(
      'UPDATE promotions SET globalReservedCount = GREATEST(0, globalReservedCount - 1), globalUsedCount = globalUsedCount + 1 WHERE id = ?',
      { replacements: [redemption.promotionId], transaction: t }
    );
    await adjustCampaignBudget(redemption.promotionId, redemption.discountAmount, t);
    if (redemption.couponCodeId) {
      await sequelize.query('UPDATE coupon_codes SET usedCount = usedCount + 1 WHERE id = ?', {
        replacements: [redemption.couponCodeId], transaction: t,
      });
    }
    return redemption.reload({ transaction: t });
  }, transaction);
}

// ─── Release (timeout / abandoned checkout) ─────────────────────────────────

async function releaseRedemption(redemptionId, reason, transaction) {
  return inTransaction(async (t) => {
    const redemption = await Redemption.findByPk(redemptionId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!redemption) throw new RedemptionError('REDEMPTION_NOT_FOUND');
    if (redemption.status === 'RELEASED') return redemption;
    if (redemption.status !== 'RESERVED') throw new RedemptionError('REDEMPTION_INVALID_STATE', `Cannot release from status "${redemption.status}"`);

    await redemption.update({
      status: 'RELEASED',
      releasedAt: new Date(),
      reason: reason || 'Released',
      // Free the key so the same booking can reserve this promotion again later.
      idempotencyKey: redemption.idempotencyKey ? `${redemption.idempotencyKey}:released:${redemption.id}` : null,
    }, { transaction: t });
    await sequelize.query('UPDATE promotions SET globalReservedCount = GREATEST(0, globalReservedCount - 1) WHERE id = ?', {
      replacements: [redemption.promotionId], transaction: t,
    });
    return redemption.reload({ transaction: t });
  }, transaction);
}

// ─── Reverse (refund / cancellation) ────────────────────────────────────────

async function reverseRedemption(redemptionId, reason, transaction) {
  return inTransaction(async (t) => {
    const redemption = await Redemption.findByPk(redemptionId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!redemption) throw new RedemptionError('REDEMPTION_NOT_FOUND');
    if (redemption.status === 'REVERSED') return redemption;
    if (redemption.status !== 'COMMITTED') throw new RedemptionError('REDEMPTION_INVALID_STATE', `Cannot reverse from status "${redemption.status}"`);

    await redemption.update({ status: 'REVERSED', reversedAt: new Date(), reason: reason || 'Reversed' }, { transaction: t });
    await sequelize.query('UPDATE promotions SET globalUsedCount = GREATEST(0, globalUsedCount - 1) WHERE id = ?', {
      replacements: [redemption.promotionId], transaction: t,
    });
    await adjustCampaignBudget(redemption.promotionId, -Number(redemption.discountAmount || 0), t);
    if (redemption.couponCodeId) {
      await sequelize.query('UPDATE coupon_codes SET usedCount = GREATEST(0, usedCount - 1) WHERE id = ?', {
        replacements: [redemption.couponCodeId], transaction: t,
      });
    }
    if (redemption.bookingId) {
      await OrderAdjustment.update(
        { reversedAt: new Date(), reversalReason: reason || 'Reversed' },
        { where: { bookingId: redemption.bookingId, promotionId: redemption.promotionId, reversedAt: null }, transaction: t }
      );
    }
    return redemption.reload({ transaction: t });
  }, transaction);
}

// ─── Cleanup expired reservations ───────────────────────────────────────────

/**
 * Releases expired checkout reservations, and is the safety net for booking holds:
 * a hold whose booking was cancelled/refunded is released even if a cancel path missed it,
 * and an expired hold on a booking that is still open is extended rather than lost.
 */
async function cleanupExpiredReservations({ limit = 500 } = {}) {
  const now = new Date();
  const expired = await Redemption.findAll({
    where: { status: 'RESERVED', reservationExpiresAt: { [Op.lt]: now } },
    attributes: ['id', 'bookingId'],
    limit,
  });
  const closedHolds = await Redemption.findAll({
    where: { status: 'RESERVED', bookingId: { [Op.ne]: null } },
    include: [{ model: Booking, as: 'booking', attributes: [], where: { bookingStatusId: CLOSED_BOOKING_STATUSES }, required: true }],
    attributes: ['id', 'bookingId'],
    limit,
  });

  const openBookingIds = new Set();
  const expiredHoldBookingIds = [...new Set(expired.filter((r) => r.bookingId).map((r) => r.bookingId))];
  if (expiredHoldBookingIds.length) {
    const open = await Booking.findAll({
      where: { id: expiredHoldBookingIds, bookingStatusId: { [Op.notIn]: CLOSED_BOOKING_STATUSES } },
      attributes: ['id'],
    });
    open.forEach((b) => openBookingIds.add(b.id));
  }

  let cleaned = 0;
  let extended = 0;
  const seen = new Set();
  for (const r of [...expired, ...closedHolds]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    try {
      if (r.bookingId && openBookingIds.has(r.bookingId) && !closedHolds.some((c) => c.id === r.id)) {
        await Redemption.update(
          { reservationExpiresAt: new Date(now.getTime() + BOOKING_HOLD_DAYS * DAY_MS) },
          { where: { id: r.id, status: 'RESERVED' } }
        );
        extended++;
        continue;
      }
      await releaseRedemption(r.id, r.bookingId ? 'Booking closed or hold expired' : 'Reservation expired');
      cleaned++;
    } catch (err) {
      console.warn(`[RedemptionCleanup] Failed to release ${r.id}:`, err.message);
    }
  }
  return { cleaned, extended, total: seen.size };
}

// ─── Booking-level helpers ──────────────────────────────────────────────────

/** All ledger rows held by a booking, oldest first. */
async function listBookingRedemptions(bookingId, transaction) {
  return Redemption.findAll({ where: { bookingId }, order: [['id', 'ASC']], transaction });
}

/** Cancel before payment: release every reservation the booking still holds. */
async function releaseBookingRedemptions(bookingId, reason, transaction) {
  const rows = await Redemption.findAll({ where: { bookingId, status: 'RESERVED' }, attributes: ['id'], transaction });
  for (const r of rows) await releaseRedemption(r.id, reason || 'Booking cancelled', transaction);
  return rows.length;
}

/** Full refund after payment: reverse every committed redemption of the booking. */
async function reverseBookingRedemptions(bookingId, reason, transaction) {
  const rows = await Redemption.findAll({ where: { bookingId, status: 'COMMITTED' }, attributes: ['id'], transaction });
  for (const r of rows) await reverseRedemption(r.id, reason || 'Booking refunded', transaction);
  return rows.length;
}

// ─── Order adjustments ──────────────────────────────────────────────────────

function classifyAdjustment(benefitType, lineType) {
  if (lineType === 'delivery') return 'DELIVERY_PROMOTION';
  if (['item_discount', 'category_discount', 'service_discount'].includes(benefitType)) return 'ITEM_PROMOTION';
  return 'BASKET_PROMOTION';
}

/**
 * Persist the engine's adjustments for a booking. Idempotent: system-applied
 * promotion adjustments already stored for the booking are replaced, so a retry
 * or a re-price never duplicates rows.
 *
 * @param {number} bookingId
 * @param {Array} appliedPromotions — evaluatePromotions().applied
 * @param {{ currency?: string, transaction?: object }} [options]
 */
async function writeOrderAdjustments(bookingId, appliedPromotions, options = {}) {
  return inTransaction(async (t) => {
    await OrderAdjustment.destroy({
      where: {
        bookingId,
        appliedBy: 'system',
        adjustmentClass: ['ITEM_PROMOTION', 'BASKET_PROMOTION', 'DELIVERY_PROMOTION'],
        reversedAt: null,
      },
      transaction: t,
    });
    const rows = [];
    for (const promo of appliedPromotions) {
      for (const adj of promo.adjustments) {
        if (!adj.amountMinor && !adj.amount) continue; // cashback rows carry no order amount
        rows.push(await OrderAdjustment.create({
          bookingId,
          adjustmentClass: classifyAdjustment(promo.benefitType, adj.lineType),
          promotionId: promo.promotionId,
          promotionVersionId: promo.promotionVersionId || null,
          couponCodeId: promo.couponCodeId || null,
          couponCode: promo.couponCode || null,
          lineType: adj.lineType || 'basket',
          lineItemId: adj.lineItemId || null,
          lineDescription: adj.lineDescription || null,
          amount: money(adj.amountMinor != null ? adj.amountMinor / 100 : adj.amount),
          currency: options.currency || 'GBP',
          label: adj.label || promo.promotionName,
          description: adj.description || null,
          appliedBy: 'system',
        }, { transaction: t }));
      }
    }
    return rows;
  }, options.transaction);
}

module.exports = {
  RedemptionError,
  RESERVATION_TTL_MINUTES,
  BOOKING_HOLD_DAYS,
  bookingReservationKey,
  reserveRedemption,
  commitRedemption,
  releaseRedemption,
  reverseRedemption,
  cleanupExpiredReservations,
  writeOrderAdjustments,
  listBookingRedemptions,
  releaseBookingRedemptions,
  reverseBookingRedemptions,
};

'use strict';

/**
 * Promotion Engine — main orchestrator.
 *
 * Runtime flow per master plan section 131:
 *   1. Build PromotionContext
 *   2. Load candidate promotions (status=active, date-valid, zone match)
 *   3. Validate coupon codes if provided
 *   4. Evaluate eligibility conditions for each candidate
 *   5. Calculate benefit for eligible promotions
 *   6. Resolve stacking / conflicts
 *   7. Generate final adjustments
 *   8. Return pricing quote additions
 */

const { Op } = require('sequelize');
const {
  promotion: Promotion,
  promotionCondition: PromotionCondition,
  promotionZoneOverride: PromotionZoneOverride,
  couponCode: CouponCode,
} = require('../../models');

const { evaluateConditions } = require('./conditionEvaluator');
const { calculateBenefit } = require('./benefitHandlers');
const { resolveStacking } = require('./stackingResolver');
const { toDecimal, money, addMoney } = require('./moneyUtils');

// ─── Load candidates ────────────────────────────────────────────────────────

/**
 * Load active promotions that could apply for a given zone and time.
 * Cheap filtering: status, dates, zone scope.
 */
async function loadCandidatePromotions(zoneId, now = new Date()) {
  const rows = await Promotion.findAll({
    where: {
      status: 'active',
      [Op.and]: [
        { [Op.or]: [{ startDate: null }, { startDate: { [Op.lte]: now } }] },
        { [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: now } }] },
      ],
    },
    include: [
      { model: PromotionCondition, as: 'conditions' },
      { model: PromotionZoneOverride, as: 'zoneOverrides' },
    ],
  });

  // Filter by zone scope
  return rows.filter((p) => {
    if (p.zoneScopeMode === 'all') return true;
    const ids = Array.isArray(p.zoneIds) ? p.zoneIds.map(Number) : [];
    const zid = Number(zoneId);
    if (p.zoneScopeMode === 'selected') return ids.includes(zid);
    if (p.zoneScopeMode === 'excluded') return !ids.includes(zid);
    return true;
  });
}

/**
 * Check recurring day/time constraints.
 */
function matchesRecurringSchedule(promo, now) {
  if (promo.recurringDays && Array.isArray(promo.recurringDays) && promo.recurringDays.length) {
    if (!promo.recurringDays.includes(now.getDay())) return false;
  }
  if (promo.recurringStartTime && promo.recurringEndTime) {
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm < promo.recurringStartTime || hhmm > promo.recurringEndTime) return false;
  }
  return true;
}

// ─── Coupon validation ──────────────────────────────────────────────────────

/**
 * Validate coupon codes and find their linked promotions.
 * Returns map: promotionId → couponCode row
 */
async function validateCouponCodes(codes = [], customerId) {
  if (!codes.length) return { valid: new Map(), errors: [] };

  const errors = [];
  const valid = new Map();
  const now = new Date();

  for (const code of codes) {
    const row = await CouponCode.findOne({
      where: { code: code.toUpperCase(), isActive: true },
    });

    if (!row) {
      errors.push({ code, error: 'INVALID_CODE', message: `Coupon code "${code}" not found or inactive` });
      continue;
    }

    // Check coupon-level dates
    if (row.activationDate && new Date(row.activationDate) > now) {
      errors.push({ code, error: 'NOT_YET_ACTIVE', message: `Coupon "${code}" not yet active` });
      continue;
    }
    if (row.expiryDate && new Date(row.expiryDate) < now) {
      errors.push({ code, error: 'EXPIRED', message: `Coupon "${code}" has expired` });
      continue;
    }

    // Check usage limits
    if (row.usageLimit != null && row.usedCount >= row.usageLimit) {
      errors.push({ code, error: 'USAGE_EXHAUSTED', message: `Coupon "${code}" has been fully redeemed` });
      continue;
    }

    // Customer-bound check
    if (row.codeType === 'customer_bound' && row.customerId && Number(row.customerId) !== Number(customerId)) {
      errors.push({ code, error: 'NOT_YOUR_CODE', message: `This coupon is assigned to another customer` });
      continue;
    }

    valid.set(row.promotionId, row);
  }

  return { valid, errors };
}

// ─── Main evaluation ────────────────────────────────────────────────────────

/**
 * Evaluate all promotions for a given context.
 *
 * @param {object} context - PromotionContext
 * @returns {{
 *   applied: Array<{ promotion, benefit, adjustments }>,
 *   rejected: Array<{ promotion, reasons }>,
 *   couponErrors: Array,
 *   totalSaving: number,
 *   adjustments: Array,
 *   cashbackAmount: number,
 * }}
 */
async function evaluatePromotions(context) {
  const now = context.currentTime || new Date();
  const zoneId = context.zone?.id;
  const customerId = context.customer?.id;

  // 1. Load candidates
  const candidates = await loadCandidatePromotions(zoneId, now);

  // 2. Validate coupons
  const { valid: couponMap, errors: couponErrors } = await validateCouponCodes(
    context.couponCodes || [],
    customerId
  );

  // 3. Evaluate each candidate
  const eligible = [];
  const rejected = [];

  for (const promo of candidates) {
    const reasons = [];

    // Check recurring schedule
    if (!matchesRecurringSchedule(promo, now)) {
      rejected.push({ promotion: promo, reasons: [{ type: 'SCHEDULE', pass: false, reason: 'Not in recurring window' }] });
      continue;
    }

    // Check activation type
    if (promo.activationType === 'coupon_required' && !couponMap.has(promo.id)) {
      // Coupon needed but not provided — skip silently (not shown to customer)
      continue;
    }

    // Check global usage limit
    if (promo.globalUsageLimit != null) {
      const total = (promo.globalUsedCount || 0) + (promo.globalReservedCount || 0);
      if (total >= promo.globalUsageLimit) {
        rejected.push({ promotion: promo, reasons: [{ type: 'USAGE_LIMIT', pass: false, reason: 'Global usage limit reached' }] });
        continue;
      }
    }

    // Check per-customer limit (needs redemption count — simplified for now)
    // Full check happens in redemptionService with SELECT FOR UPDATE

    // Evaluate typed conditions
    const conditions = promo.conditions || [];
    const evaluation = evaluateConditions(conditions, context);

    if (!evaluation.eligible) {
      rejected.push({ promotion: promo, reasons: evaluation.results.filter((r) => !r.pass) });
      continue;
    }

    // Find zone override
    const zoneOverride = (promo.zoneOverrides || []).find(
      (zo) => Number(zo.zoneId) === Number(zoneId) && zo.isActive
    );

    // Calculate benefit
    const benefit = calculateBenefit(promo, context, { zoneOverride });

    if (benefit.totalSaving > 0 || benefit.cashbackAmount > 0) {
      eligible.push({ promotion: promo, benefit, evaluation, coupon: couponMap.get(promo.id) || null });
    } else {
      rejected.push({ promotion: promo, reasons: [{ type: 'NO_BENEFIT', pass: false, reason: 'Calculated saving is £0' }] });
    }
  }

  // 4. Resolve stacking
  const applied = resolveStacking(eligible);

  // 5. Build final results
  let totalSaving = 0;
  let cashbackAmount = 0;
  const allAdjustments = [];

  for (const entry of applied) {
    totalSaving = addMoney(totalSaving, entry.benefit.totalSaving || 0);
    cashbackAmount = addMoney(cashbackAmount, entry.benefit.cashbackAmount || 0);

    for (const adj of entry.benefit.adjustments) {
      allAdjustments.push({
        ...adj,
        promotionId: entry.promotion.id,
        promotionName: entry.promotion.name,
        couponCode: entry.coupon?.code || null,
      });
    }
  }

  return {
    applied: applied.map((e) => ({
      promotionId: e.promotion.id,
      promotionName: e.promotion.name,
      benefitType: e.promotion.benefitType,
      couponCode: e.coupon?.code || null,
      totalSaving: e.benefit.totalSaving,
      cashbackAmount: e.benefit.cashbackAmount || 0,
      adjustments: e.benefit.adjustments,
    })),
    rejected: rejected.map((e) => ({
      promotionId: e.promotion.id,
      promotionName: e.promotion.name,
      reasons: e.reasons,
    })),
    couponErrors,
    totalSaving,
    cashbackAmount,
    adjustments: allAdjustments,
  };
}

/**
 * Simulate promotion evaluation (admin tool).
 * Same as evaluatePromotions but with full explainability.
 */
async function simulatePromotions(context) {
  const result = await evaluatePromotions(context);
  return {
    ...result,
    explainability: {
      totalCandidatesLoaded: result.applied.length + result.rejected.length,
      eligibleCount: result.applied.length,
      rejectedCount: result.rejected.length,
      couponErrorCount: result.couponErrors.length,
    },
  };
}

/**
 * Get customer-facing offers for a zone.
 * Returns promotions visible to customer (public + their targeted).
 */
async function getCustomerOffers(zoneId, customerId) {
  const now = new Date();
  const candidates = await loadCandidatePromotions(zoneId, now);

  return candidates
    .filter((p) => p.visibility === 'public' || p.visibility === 'targeted')
    .filter((p) => p.activationType !== 'coupon_required')
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      benefitType: p.benefitType,
      discountValue: p.discountValue,
      maxDiscountCap: p.maxDiscountCap,
      minSubtotal: p.minSubtotal,
      endDate: p.endDate,
      label: buildOfferLabel(p),
    }));
}

function buildOfferLabel(promo) {
  const val = toDecimal(promo.discountValue);
  switch (promo.benefitType) {
    case 'percentage_discount':
    case 'first_order_discount':
      return `${val}% OFF${promo.maxDiscountCap ? ` (up to £${money(promo.maxDiscountCap)})` : ''}`;
    case 'fixed_amount_discount':
      return `£${money(val)} OFF`;
    case 'free_delivery':
      return 'Free Delivery';
    case 'delivery_discount':
      return `£${money(val)} off delivery`;
    default:
      return promo.name;
  }
}

module.exports = {
  evaluatePromotions,
  simulatePromotions,
  getCustomerOffers,
  loadCandidatePromotions,
  validateCouponCodes,
  buildOfferLabel,
};

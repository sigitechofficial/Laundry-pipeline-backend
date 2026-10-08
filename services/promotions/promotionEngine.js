'use strict';

/**
 * Promotion Engine — main orchestrator.
 *
 * Runtime flow per master plan section 131:
 *   1. PromotionContext is built server-side (contextBuilder)
 *   2. Load candidate promotions (status=active, date-valid, zone match)
 *   3. Validate coupon codes if provided (against live promotions only)
 *   4. Built-in limits (min spend, first order, usage limits) + typed conditions
 *   5. Resolve stacking and apply benefits on one shared basket (stackingResolver)
 *   6. Return adjustments + totals (minor units are authoritative)
 */

const { Op } = require('sequelize');
const {
  promotion: Promotion,
  promotionCondition: PromotionCondition,
  promotionZoneOverride: PromotionZoneOverride,
  promotionRedemption: Redemption,
  couponCode: CouponCode,
  campaign: Campaign,
} = require('../../models');

const { evaluateConditions } = require('./conditionEvaluator');
const { benefitScope, effectiveValues, resolveDiscountMode, currencySymbol } = require('./benefitHandlers');
const { resolveAndApply } = require('./stackingResolver');
const { toDecimal, toMinor, fromMinor, money } = require('./moneyUtils');
const { localClock, isWithinWindow } = require('./promotionTime');

const DAY_MS = 24 * 60 * 60 * 1000;
const BLOCKING_CAMPAIGN_STATUSES = ['paused', 'completed', 'archived'];
const CUSTOMER_LEVEL_CONDITIONS = ['ZONE', 'CUSTOMER_TYPE', 'CUSTOMER_SEGMENT', 'FIRST_ORDER', 'ORDER_COUNT'];

// ─── Live checks ────────────────────────────────────────────────────────────

function zoneInScope(promo, zoneId) {
  if (promo.zoneScopeMode === 'all' || !promo.zoneScopeMode) return true;
  const ids = Array.isArray(promo.zoneIds) ? promo.zoneIds.map(Number) : [];
  const zid = Number(zoneId);
  if (promo.zoneScopeMode === 'selected') return ids.includes(zid);
  if (promo.zoneScopeMode === 'excluded') return !ids.includes(zid);
  return false;
}

/** Is the promotion redeemable right now in this zone? */
function isLive(promo, now, zoneId) {
  if (!promo || promo.status !== 'active') return false;
  if (promo.startDate && new Date(promo.startDate) > now) return false;
  if (promo.endDate && new Date(promo.endDate) < now) return false;
  return zoneId == null ? true : zoneInScope(promo, zoneId);
}

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
      { model: Campaign, as: 'campaign', attributes: ['id', 'status', 'budgetMinor', 'usedBudgetMinor'] },
    ],
  });
  // A paused/completed/archived campaign switches off all of its promotions
  return rows.filter((p) => zoneInScope(p, zoneId) && !BLOCKING_CAMPAIGN_STATUSES.includes(p.campaign?.status));
}

/** Recurring weekday / time window, in the zone's timezone. Overnight windows supported. */
function matchesRecurringSchedule(promo, context) {
  const { day, hhmm } = localClock(context.currentTime, context.zone?.timezone);
  if (Array.isArray(promo.recurringDays) && promo.recurringDays.length) {
    if (!promo.recurringDays.map(Number).includes(day)) return false;
  }
  return isWithinWindow(hhmm, promo.recurringStartTime, promo.recurringEndTime);
}

// ─── Usage (ledger) ─────────────────────────────────────────────────────────

/** A reservation still holds an entitlement until it expires. */
function holdsEntitlement(r, now) {
  if (r.status === 'COMMITTED') return true;
  return r.status === 'RESERVED' && (!r.reservationExpiresAt || new Date(r.reservationExpiresAt) > now);
}

/** Map promotionId → { total, lastDay, lastWeek } for one customer. */
async function loadCustomerUsage(promotionIds, customerId, now) {
  const usage = new Map();
  if (!customerId || !promotionIds.length) return usage;
  const rows = await Redemption.findAll({
    where: { customerId, promotionId: promotionIds, status: { [Op.in]: ['RESERVED', 'COMMITTED'] } },
    attributes: ['promotionId', 'status', 'reservationExpiresAt', 'reservedAt', 'committedAt', 'createdAt'],
  });
  for (const r of rows) {
    if (!holdsEntitlement(r, now)) continue;
    const at = new Date(r.committedAt || r.reservedAt || r.createdAt).getTime();
    const u = usage.get(r.promotionId) || { total: 0, lastDay: 0, lastWeek: 0 };
    u.total += 1;
    if (now.getTime() - at < DAY_MS) u.lastDay += 1;
    if (now.getTime() - at < 7 * DAY_MS) u.lastWeek += 1;
    usage.set(r.promotionId, u);
  }
  return usage;
}

// ─── Coupon validation ──────────────────────────────────────────────────────

function couponError(code, error, message) {
  return { code, error, message };
}

/**
 * Validate coupon codes against live promotions.
 * Returns valid: Map promotionId → couponCode row, errors: [{ code, error, message }]
 */
async function validateCouponCodes(codes = [], { customerId, zoneId, now = new Date() } = {}) {
  const list = (Array.isArray(codes) ? codes : [codes]).map((c) => String(c ?? '').trim()).filter(Boolean);
  const errors = [];
  const valid = new Map();
  if (!list.length) return { valid, errors };

  for (const code of list) {
    const row = await CouponCode.findOne({
      where: { code: code.toUpperCase() },
      include: [{ model: Promotion, as: 'promotion' }],
    });

    if (!row || !row.isActive) {
      errors.push(couponError(code, 'INVALID_CODE', `Coupon code "${code}" not found or inactive`));
      continue;
    }
    if (row.activationDate && new Date(row.activationDate) > now) {
      errors.push(couponError(code, 'NOT_YET_ACTIVE', `Coupon "${code}" not yet active`));
      continue;
    }
    if (row.expiryDate && new Date(row.expiryDate) < now) {
      errors.push(couponError(code, 'EXPIRED', `Coupon "${code}" has expired`));
      continue;
    }
    const promo = row.promotion;
    if (!promo || !isLive(promo, now, null)) {
      errors.push(couponError(code, 'PROMOTION_NOT_ACTIVE', `Coupon "${code}" is not available right now`));
      continue;
    }
    if (zoneId != null && !zoneInScope(promo, zoneId)) {
      errors.push(couponError(code, 'WRONG_ZONE', `Coupon "${code}" is not valid in your area`));
      continue;
    }
    if (row.codeType === 'customer_bound' && row.customerId && Number(row.customerId) !== Number(customerId)) {
      errors.push(couponError(code, 'NOT_YOUR_CODE', 'This coupon is assigned to another customer'));
      continue;
    }

    const activeReservations = await Redemption.count({
      where: { couponCodeId: row.id, status: 'RESERVED', reservationExpiresAt: { [Op.gt]: now } },
    });
    if (row.usageLimit != null && row.usedCount + activeReservations >= row.usageLimit) {
      errors.push(couponError(code, 'USAGE_EXHAUSTED', `Coupon "${code}" has been fully redeemed`));
      continue;
    }
    if (row.perCustomerLimit != null && customerId) {
      const mine = await Redemption.findAll({
        where: { couponCodeId: row.id, customerId, status: { [Op.in]: ['RESERVED', 'COMMITTED'] } },
        attributes: ['status', 'reservationExpiresAt'],
      });
      if (mine.filter((r) => holdsEntitlement(r, now)).length >= row.perCustomerLimit) {
        errors.push(couponError(code, 'ALREADY_USED', `You have already used coupon "${code}"`));
        continue;
      }
    }

    valid.set(row.promotionId, row);
  }

  return { valid, errors };
}

// ─── Built-in rules ─────────────────────────────────────────────────────────

function reject(type, reason, code, meta) {
  return { type, pass: false, reason, ...(code ? { code } : {}), ...(meta ? { meta } : {}) };
}

/**
 * Rules that come from promotion columns rather than condition rows:
 * spend/quantity limits, first-order benefit types and usage limits.
 * @returns {object|null} failing reason, or null when all pass
 */
function builtInCheck(promo, context, zoneOverride, usage) {
  const subtotal = toDecimal(context.basket?.subtotal);
  const sym = currencySymbol(promo.currency);
  const { minSubtotal } = effectiveValues(promo, zoneOverride);
  if (minSubtotal != null && minSubtotal > 0 && subtotal < minSubtotal) {
    const short = fromMinor(toMinor(minSubtotal) - toMinor(subtotal));
    return reject('MINIMUM_SUBTOTAL', `Spend ${sym}${money(short)} more to use this offer`, 'PROMOTION_MIN_SPEND_NOT_MET', {
      requiredMinor: toMinor(minSubtotal), currentMinor: toMinor(subtotal), currency: promo.currency || 'GBP',
    });
  }
  if (promo.maxSubtotal != null && toDecimal(promo.maxSubtotal) > 0 && subtotal > toDecimal(promo.maxSubtotal)) {
    return reject('MAXIMUM_SUBTOTAL', `Order above ${sym}${money(promo.maxSubtotal)} is not eligible`, 'PROMOTION_MAX_SPEND_EXCEEDED');
  }
  if (promo.minQuantity != null && Number(promo.minQuantity) > 0 && (context.basket?.itemCount || 0) < Number(promo.minQuantity)) {
    return reject('MINIMUM_QUANTITY', `Add at least ${promo.minQuantity} items`, 'PROMOTION_MIN_QUANTITY_NOT_MET');
  }

  const orderCount = Number(context.customer?.orderCount ?? 0);
  if (promo.benefitType === 'first_order_discount' && orderCount > 0) {
    return reject('FIRST_ORDER', 'Only for your first order', 'PROMOTION_FIRST_ORDER_ONLY');
  }
  if (promo.benefitType === 'first_x_orders_discount') {
    const firstOrders = Number(promo.benefitConfig?.firstOrders) || 1;
    if (orderCount >= firstOrders) {
      return reject('ORDER_COUNT', `Only for your first ${firstOrders} orders`, 'PROMOTION_FIRST_ORDERS_ONLY');
    }
  }

  if (promo.globalUsageLimit != null && (promo.globalUsedCount || 0) + (promo.globalReservedCount || 0) >= promo.globalUsageLimit) {
    return reject('USAGE_LIMIT', 'This offer has been fully redeemed', 'PROMOTION_USAGE_EXHAUSTED');
  }
  const campaign = promo.campaign;
  if (campaign && campaign.budgetMinor != null && Number(campaign.usedBudgetMinor || 0) >= Number(campaign.budgetMinor)) {
    return reject('BUDGET', 'This offer is no longer available', 'PROMOTION_BUDGET_EXHAUSTED');
  }
  const u = usage.get(promo.id) || { total: 0, lastDay: 0, lastWeek: 0 };
  if (promo.perCustomerLimit != null && u.total >= promo.perCustomerLimit) {
    return reject('USAGE_LIMIT', 'You have already used this offer', 'PROMOTION_PER_CUSTOMER_LIMIT');
  }
  if (promo.perDayLimit != null && u.lastDay >= promo.perDayLimit) {
    return reject('USAGE_LIMIT', 'Daily limit for this offer reached', 'PROMOTION_DAILY_LIMIT');
  }
  if (promo.perWeekLimit != null && u.lastWeek >= promo.perWeekLimit) {
    return reject('USAGE_LIMIT', 'Weekly limit for this offer reached', 'PROMOTION_WEEKLY_LIMIT');
  }
  return null;
}

// ─── Main evaluation ────────────────────────────────────────────────────────

/**
 * Evaluate all promotions for a server-built PromotionContext.
 * Money fields ending in Minor are integers (pence); the decimal twins are for display.
 */
async function evaluatePromotions(context) {
  const now = context.currentTime instanceof Date ? context.currentTime : new Date();
  context = { ...context, currentTime: now };
  const zoneId = context.zone?.id;
  const customerId = context.customer?.id;

  const candidates = await loadCandidatePromotions(zoneId, now);
  const { valid: couponMap, errors: couponErrors } = await validateCouponCodes(context.couponCodes || [], { customerId, zoneId, now });
  const usage = await loadCustomerUsage(candidates.map((p) => p.id), customerId, now);

  const eligible = [];
  const rejected = [];
  let skippedCouponRequired = 0;

  for (const promo of candidates) {
    const zoneOverride = (promo.zoneOverrides || []).find((zo) => Number(zo.zoneId) === Number(zoneId) && zo.isActive !== false) || null;
    const coupon = couponMap.get(promo.id) || null;

    if (promo.activationType === 'coupon_required' && !coupon) {
      skippedCouponRequired += 1; // not offered without its code
      continue;
    }
    if (!benefitScope(promo.benefitType)) {
      rejected.push({ promotion: promo, coupon, reasons: [reject('UNSUPPORTED', `Benefit type ${promo.benefitType} is not available yet`, 'PROMOTION_UNSUPPORTED')] });
      continue;
    }
    if (!matchesRecurringSchedule(promo, context)) {
      rejected.push({ promotion: promo, coupon, reasons: [reject('SCHEDULE', 'Not available at this time', 'PROMOTION_OUTSIDE_SCHEDULE')] });
      continue;
    }
    const builtIn = builtInCheck(promo, context, zoneOverride, usage);
    if (builtIn) {
      rejected.push({ promotion: promo, coupon, reasons: [builtIn] });
      continue;
    }
    const evaluation = evaluateConditions(promo.conditions || [], context);
    if (!evaluation.eligible) {
      rejected.push({ promotion: promo, coupon, reasons: evaluation.results.filter((r) => !r.pass) });
      continue;
    }
    eligible.push({ promotion: promo, zoneOverride, coupon, pending: evaluation.pending });
  }

  const resolution = resolveAndApply(eligible, context);
  for (const r of resolution.rejected) rejected.push(r);

  const adjustments = [];
  for (const entry of resolution.applied) {
    for (const adj of entry.benefit.adjustments) {
      adjustments.push({
        ...adj,
        promotionId: entry.promotion.id,
        promotionVersionId: entry.promotion.currentVersionId || null,
        promotionName: entry.promotion.name,
        couponCode: entry.coupon?.code || null,
        couponCodeId: entry.coupon?.id || null,
      });
    }
  }

  const deliverySavingMinor = adjustments.filter((a) => a.lineType === 'delivery').reduce((s, a) => s - a.amountMinor, 0);
  const subtotalMinor = resolution.subtotalMinor;
  const itemSavingMinor = resolution.totalSavingMinor - deliverySavingMinor;
  const deliveryFeeMinor = toMinor(context.basket?.deliveryFee);

  const nearEligible = rejected
    .filter((r) => r.reasons.some((x) => x.code === 'PROMOTION_MIN_SPEND_NOT_MET') && r.promotion.visibility === 'public')
    .map((r) => {
      const reason = r.reasons.find((x) => x.code === 'PROMOTION_MIN_SPEND_NOT_MET');
      return { promotionId: r.promotion.id, promotionName: r.promotion.name, message: reason.reason, meta: reason.meta || null };
    });

  return {
    applied: resolution.applied.map((e) => ({
      promotionId: e.promotion.id,
      promotionVersionId: e.promotion.currentVersionId || null,
      promotionName: e.promotion.name,
      benefitType: e.promotion.benefitType,
      couponCode: e.coupon?.code || null,
      couponCodeId: e.coupon?.id || null,
      totalSaving: e.benefit.totalSaving,
      totalSavingMinor: e.benefit.totalSavingMinor,
      cashbackAmount: e.benefit.cashbackAmount,
      cashbackMinor: e.benefit.cashbackMinor,
      pending: Boolean(e.pending),
      adjustments: e.benefit.adjustments,
    })),
    rejected: rejected.map((e) => ({
      promotionId: e.promotion.id,
      promotionName: e.promotion.name,
      visibility: e.promotion.visibility,
      couponCode: e.coupon?.code || null,
      reasons: e.reasons,
    })),
    couponErrors,
    nearEligible,
    currency: 'GBP',
    subtotal: fromMinor(subtotalMinor),
    subtotalMinor,
    deliveryFee: fromMinor(deliveryFeeMinor),
    deliveryFeeMinor,
    totalSaving: fromMinor(resolution.totalSavingMinor),
    totalSavingMinor: resolution.totalSavingMinor,
    deliverySaving: fromMinor(deliverySavingMinor),
    deliverySavingMinor,
    finalSubtotal: fromMinor(subtotalMinor - itemSavingMinor),
    finalSubtotalMinor: subtotalMinor - itemSavingMinor,
    cashbackAmount: fromMinor(resolution.cashbackMinor),
    cashbackMinor: resolution.cashbackMinor,
    pending: resolution.applied.some((e) => e.pending),
    adjustments,
    explainability: {
      totalCandidatesLoaded: candidates.length,
      skippedCouponRequired,
      eligibleCount: eligible.length,
      appliedCount: resolution.applied.length,
      rejectedCount: rejected.length,
      couponErrorCount: couponErrors.length,
    },
  };
}

/** Admin simulation: same engine, full explainability (including hidden promotions). */
async function simulatePromotions(context) {
  return evaluatePromotions(context);
}

/**
 * Customer-safe view of an evaluation: no hidden/targeted promotion names unless
 * the customer typed a code for it, no internal explainability.
 */
function toCustomerView(result) {
  return {
    applied: result.applied.map(({ promotionVersionId, couponCodeId, ...rest }) => ({
      ...rest,
      adjustments: rest.adjustments.map(({ meta, ...a }) => (meta ? { ...a, cashbackAmount: meta.cashbackAmount } : a)),
    })),
    rejected: result.rejected
      .filter((r) => r.visibility === 'public' || r.couponCode)
      .map((r) => ({
        promotionId: r.promotionId,
        promotionName: r.promotionName,
        couponCode: r.couponCode,
        reasons: r.reasons.map(({ code, reason, meta }) => ({ code: code || null, reason, meta: meta || null })),
      })),
    couponErrors: result.couponErrors,
    nearEligible: result.nearEligible,
    currency: result.currency,
    subtotal: result.subtotal,
    subtotalMinor: result.subtotalMinor,
    deliveryFee: result.deliveryFee,
    deliveryFeeMinor: result.deliveryFeeMinor,
    totalSaving: result.totalSaving,
    totalSavingMinor: result.totalSavingMinor,
    deliverySaving: result.deliverySaving,
    deliverySavingMinor: result.deliverySavingMinor,
    finalSubtotal: result.finalSubtotal,
    finalSubtotalMinor: result.finalSubtotalMinor,
    cashbackAmount: result.cashbackAmount,
    cashbackMinor: result.cashbackMinor,
    pending: result.pending,
  };
}

// ─── Customer offers ────────────────────────────────────────────────────────

/**
 * Offers a customer can see for a zone: public automatic promotions plus targeted
 * ones whose customer-level conditions (first order, order count, customer type…) they meet.
 * @param {object} context PromotionContext built server-side (basket may be empty)
 */
async function getCustomerOffers(context) {
  const now = context.currentTime instanceof Date ? context.currentTime : new Date();
  const candidates = await loadCandidatePromotions(context.zone?.id, now);
  const usage = await loadCustomerUsage(candidates.map((p) => p.id), context.customer?.id, now);

  const offers = [];
  for (const p of candidates) {
    if (p.activationType === 'coupon_required') continue;
    if (!['public', 'targeted'].includes(p.visibility)) continue;
    if (!benefitScope(p.benefitType)) continue;

    // Only customer-level rules — basket rules are shown as "min spend" text instead
    const customerConditions = (p.conditions || []).filter((c) => CUSTOMER_LEVEL_CONDITIONS.includes(c.conditionType));
    if (p.visibility === 'targeted' && !customerConditions.length) continue;
    if (!evaluateConditions(customerConditions, { ...context, currentTime: now }).eligible) continue;

    const limitCheck = builtInCheck(
      { ...p.get({ plain: true }), minSubtotal: null, maxSubtotal: null, minQuantity: null },
      { ...context, basket: { subtotal: 0, itemCount: 0 } },
      null,
      usage
    );
    if (limitCheck) continue;

    const zoneOverride = (p.zoneOverrides || []).find((zo) => Number(zo.zoneId) === Number(context.zone?.id)) || null;
    const values = effectiveValues(p, zoneOverride);
    offers.push({
      id: p.id,
      name: p.name,
      description: p.description,
      benefitType: p.benefitType,
      discountMode: resolveDiscountMode(p),
      discountValue: values.discountValue,
      maxDiscountCap: values.maxDiscountCap,
      minSubtotal: values.minSubtotal,
      endDate: p.endDate,
      recurring: Boolean((p.recurringDays && p.recurringDays.length) || p.recurringStartTime),
      label: buildOfferLabel(p, zoneOverride),
    });
  }
  return offers;
}

function buildOfferLabel(promo, zoneOverride = null) {
  const { discountValue, maxDiscountCap, minSubtotal, currency } = effectiveValues(promo, zoneOverride);
  const sym = currencySymbol(currency);
  const mode = resolveDiscountMode(promo);
  const value = mode === 'percent' ? `${discountValue}%` : `${sym}${money(discountValue)}`;
  const cap = mode === 'percent' && maxDiscountCap ? ` (up to ${sym}${money(maxDiscountCap)})` : '';
  const min = minSubtotal ? ` on orders over ${sym}${money(minSubtotal)}` : '';
  switch (promo.benefitType) {
    case 'percentage_discount':
    case 'fixed_amount_discount':
    case 'basket_discount':
      return `${value} OFF${cap}${min}`;
    case 'first_order_discount':
      return `${value} OFF your first order${cap}`;
    case 'first_x_orders_discount':
      return `${value} OFF your first ${Number(promo.benefitConfig?.firstOrders) || 1} orders${cap}`;
    case 'item_discount':
    case 'category_discount':
    case 'service_discount':
      return mode === 'percent' ? `${value} OFF selected items${cap}` : `${value} OFF each selected item`;
    case 'fixed_price':
      return `Special price ${sym}${money(discountValue)}`;
    case 'free_delivery':
      return `Free Delivery${min}`;
    case 'delivery_discount':
      return `${sym}${money(discountValue)} off delivery${min}`;
    case 'cashback':
      return `${value} cashback${cap}`;
    default:
      return promo.name;
  }
}

module.exports = {
  evaluatePromotions,
  simulatePromotions,
  toCustomerView,
  getCustomerOffers,
  loadCandidatePromotions,
  validateCouponCodes,
  buildOfferLabel,
  isLive,
  zoneInScope,
  holdsEntitlement,
  builtInCheck,
};

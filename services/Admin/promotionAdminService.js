'use strict';

const { Op, literal } = require('sequelize');
const {
  promotion: Promotion,
  promotionVersion: PromotionVersion,
  promotionCondition: PromotionCondition,
  promotionZoneOverride: PromotionZoneOverride,
  couponCode: CouponCode,
  coupon: LegacyCoupon,
  campaign: Campaign,
  promotionAuditLog: AuditLog,
  sequelize,
} = require('../../models');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../middlewares/universalErrorHandler');
const { SUPPORTED_BENEFIT_TYPES, resolveDiscountMode } = require('../promotions/benefitHandlers');
const { validateCondition } = require('../promotions/conditionEvaluator');
const { normalizeHHMM, businessDayBound } = require('../promotions/promotionTime');
const { CLOSED_STATUSES, campaignBlock } = require('../promotions/campaignRules');
const { attachHeldBudget } = require('../promotions/campaignBudget');
const { BOOKED_HOLD_SQL } = require('../promotions/bookedHold');

const CAMPAIGN_SUMMARY = ['id', 'name', 'status', 'startDate', 'endDate', 'budgetMinor', 'usedBudgetMinor', 'ownerPromotionId'];

/**
 * Why new orders cannot use the promotion because of its campaign, or null. Shown in the
 * admin list so a promotion in a paused / ended / over-budget campaign is not read as running.
 */
async function withCampaignStop(rows, now = new Date()) {
  await attachHeldBudget(rows, { now });
  for (const p of rows) {
    const stop = p.campaign ? campaignBlock(p.campaign, now) : null;
    p.setDataValue('campaignStopReason', stop ? stop.code : null);
  }
  return rows;
}

// ─── Audit helper ────────────────────────────────────────────────────────────

async function audit(entityId, action, actorId, extras = {}, transaction) {
  try {
    await AuditLog.create({
      entityType: 'promotion',
      entityId,
      action,
      actorId: actorId || null,
      actorType: actorId ? 'admin' : 'system',
      ...extras,
    }, { transaction });
  } catch (err) {
    console.error('[AuditLog] write fail:', err.message);
  }
}

// ─── Valid lifecycle transitions ─────────────────────────────────────────────
// active / scheduled are only entered via publish (which creates a version);
// scheduled → active and → expired are done by the promotion job.

const TRANSITIONS = {
  draft:            ['pending_approval', 'archived'],
  pending_approval: ['approved', 'draft', 'archived'],
  approved:         ['draft', 'archived'],
  scheduled:        ['paused', 'archived'],
  active:           ['paused', 'archived'],
  paused:           ['archived'],
  expired:          ['archived'],
  archived:         [],
};
const PUBLISHABLE = ['draft', 'approved', 'paused'];
const EDITABLE = ['draft', 'paused'];
/** Live offers: only these change without pausing (they don't change what a booked order gets). */
const LIVE_STATUSES = ['active', 'scheduled'];
const LIVE_EDITABLE = ['name', 'description', 'internalNotes', 'endDate', 'globalUsageLimit', 'perCustomerLimit', 'budget'];

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// ─── Zone scope (zone staff only manage promotions for their own zone) ───────

/** Zone id the admin is restricted to, or null for platform admins/staff. */
function restrictedZoneOf(scope) {
  if (!scope || scope.isPlatformAdmin) return null;
  if (scope.roleScope !== 'zone') return null;
  const zoneId = Number(scope.zoneId);
  if (!Number.isInteger(zoneId) || zoneId <= 0) {
    throw new ForbiddenError('Your account has no zone assigned');
  }
  return zoneId;
}

function assertInScope(promo, scope) {
  const zoneId = restrictedZoneOf(scope);
  if (zoneId == null) return;
  const ids = Array.isArray(promo.zoneIds) ? promo.zoneIds.map(Number) : [];
  if (promo.zoneScopeMode !== 'selected' || ids.length !== 1 || ids[0] !== zoneId) {
    throw new NotFoundError('Promotion not found');
  }
}

// ─── Full include for detail queries ────────────────────────────────────────

const FULL_INCLUDE = [
  { model: PromotionCondition, as: 'conditions', separate: true, order: [['sortOrder', 'ASC']] },
  { model: PromotionZoneOverride, as: 'zoneOverrides' },
  {
    model: CouponCode,
    as: 'couponCodes',
    attributes: ['id', 'code', 'codeType', 'customerId', 'usedCount', 'usageLimit', 'perCustomerLimit', 'activationDate', 'expiryDate', 'isActive'],
  },
  { model: PromotionVersion, as: 'versions', separate: true, order: [['versionNumber', 'DESC']], limit: 10 },
  { model: Campaign, as: 'campaign', attributes: CAMPAIGN_SUMMARY },
];

// ─── Payload normalisation & validation ─────────────────────────────────────

const SCALAR_FIELDS = [
  'campaignId', 'name', 'description', 'internalNotes', 'benefitType', 'discountValue', 'discountMode', 'maxDiscountCap',
  'benefitConfig', 'currency', 'targetType', 'targetIds', 'zoneScopeMode', 'zoneIds', 'startDate', 'endDate',
  'recurringDays', 'recurringStartTime', 'recurringEndTime', 'activationType', 'visibility', 'priority', 'stackable',
  'stackGroup', 'globalUsageLimit', 'perCustomerLimit', 'perDayLimit', 'perWeekLimit', 'minSubtotal', 'maxSubtotal',
  'minQuantity', 'repricingPolicy', 'tags',
];
const DECIMAL_FIELDS = ['discountValue', 'maxDiscountCap', 'minSubtotal', 'maxSubtotal'];
const INT_FIELDS = ['campaignId', 'priority', 'globalUsageLimit', 'perCustomerLimit', 'perDayLimit', 'perWeekLimit', 'minQuantity'];
const ITEM_TYPES = ['item_discount', 'category_discount', 'service_discount', 'bundle'];
/** Item / add-on / category / service / all — chosen by targetType. */
const TARGET_TYPE_PICKED = ['item_discount', 'bundle'];
const DEFAULTS = {
  currency: 'GBP', targetType: 'basket', zoneScopeMode: 'all', activationType: 'automatic', visibility: 'public',
  priority: 50, stackable: false, perCustomerLimit: 1, repricingPolicy: 'recalculate',
};

const blank = (v) => v === '' || v === undefined;

// ─── What the benefit type already decides ──────────────────────────────────

const FIRST_ORDER_TYPES = ['first_order_discount', 'first_x_orders_discount'];
const ORDER_HISTORY_CONDITIONS = { FIRST_ORDER: 'First order', CUSTOMER_TYPE: 'Customer type', ORDER_COUNT: 'Previous order count' };

/**
 * Limits the type fixes, whatever the caller sent: a first-order promotion is used once
 * per customer; a first-N-orders one N times (a lower limit would stop it before order N).
 */
function typeRuleFields(p) {
  if (p.benefitType === 'first_order_discount') return { perCustomerLimit: 1, perDayLimit: null, perWeekLimit: null };
  // Bulk price with several deals: the offer's items are every deal's items; the first deal
  // fills the single-deal fields so older screens and reports still read it.
  const deals = p.benefitType === 'bundle' && Array.isArray(p.benefitConfig?.deals) ? p.benefitConfig.deals : null;
  if (deals && deals.length) {
    return {
      targetType: 'subCategory',
      targetIds: [...new Set(deals.flatMap((d) => d.itemIds || []))],
      discountValue: deals[0].price,
      benefitConfig: { ...p.benefitConfig, bundleQuantity: deals[0].quantity },
    };
  }
  if (p.benefitType === 'first_x_orders_discount') {
    const n = Number(p.benefitConfig?.firstOrders);
    return Number.isInteger(n) && n >= 1 ? { perCustomerLimit: n } : {};
  }
  return {};
}

/** A first-order type already says who qualifies: an order-history condition repeats or contradicts it. */
function assertNoOrderHistoryCondition(benefitType, conditions) {
  if (!FIRST_ORDER_TYPES.includes(benefitType)) return;
  const clash = (conditions || []).find((c) => ORDER_HISTORY_CONDITIONS[c.conditionType]);
  if (!clash) return;
  const scope = benefitType === 'first_order_discount' ? "a customer's first order" : "a customer's first orders";
  throw new ValidationError(`This promotion type is already limited to ${scope}. Remove the "${ORDER_HISTORY_CONDITIONS[clash.conditionType]}" condition.`);
}

/** JSON id lists may arrive as numbers, numeric strings, or a JSON string — normalize to unique positive ints. */
function asIntIdList(value) {
  let arr = value;
  if (arr == null || arr === '') return [];
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
}

/** benefitConfig may arrive as a JSON string; a Bulk price group size typed in a form arrives as text. */
function normalizeBenefitConfig(value) {
  let config = value;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { return null; }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const out = { ...config };
  if ('bundleQuantity' in out) {
    const n = out.bundleQuantity;
    out.bundleQuantity = blank(n) || n == null ? null : Number(n);
  }
  // Bulk price deals: [{ itemIds, quantity, price }]
  if ('deals' in out) {
    out.deals = Array.isArray(out.deals)
      ? out.deals.map((d = {}) => ({
        itemIds: asIntIdList(d.itemIds),
        // Services this deal counts in (empty = any service).
        serviceIds: asIntIdList(d.serviceIds),
        quantity: blank(d.quantity) || d.quantity == null ? null : Number(d.quantity),
        price: blank(d.price) || d.price == null ? null : Number(d.price),
      }))
      : [];
    if (!out.deals.length) delete out.deals;
  }
  // Items count only in these services (empty = any service).
  if ('onlyServiceIds' in out) {
    const ids = asIntIdList(out.onlyServiceIds) || [];
    if (ids.length) out.onlyServiceIds = ids;
    else delete out.onlyServiceIds;
  }
  return out;
}

/** Keep only known fields; "" → null; numbers parsed; codes/times normalised. */
function normalizePayload(payload = {}) {
  const out = {};
  for (const key of SCALAR_FIELDS) {
    if (!(key in payload)) continue;
    let v = payload[key];
    if (blank(v)) v = null;
    if (v != null && DECIMAL_FIELDS.includes(key)) v = Number(v);
    if (v != null && INT_FIELDS.includes(key)) v = Number(v);
    if (key === 'name' && v != null) v = String(v).trim();
    if (key === 'stackGroup' && v != null) v = String(v).trim() || null;
    if (key === 'benefitConfig' && v != null) v = normalizeBenefitConfig(v);
    if ((key === 'recurringStartTime' || key === 'recurringEndTime') && v != null) v = normalizeHHMM(v) || '__invalid__';
    if (key === 'startDate' && v != null) v = businessDayBound(v, 'start');
    if (key === 'endDate' && v != null) v = businessDayBound(v, 'end');
    if (key === 'targetIds' || key === 'zoneIds' || key === 'recurringDays') {
      if (v == null) {
        out[key] = null;
        continue;
      }
      v = asIntIdList(v);
    }
    out[key] = v;
  }
  if (Array.isArray(payload.conditions)) {
    out.conditions = payload.conditions.map((c, i) => ({
      conditionType: c.conditionType,
      operator: c.operator || 'equals',
      value: c.value,
      logicGroup: c.logicGroup || 'ALL',
      sortOrder: c.sortOrder ?? i,
    }));
  }
  if (Array.isArray(payload.zoneOverrides)) {
    out.zoneOverrides = payload.zoneOverrides.map((zo) => ({
      zoneId: Number(zo.zoneId),
      discountValue: blank(zo.discountValue) || zo.discountValue == null ? null : Number(zo.discountValue),
      maxDiscountCap: blank(zo.maxDiscountCap) || zo.maxDiscountCap == null ? null : Number(zo.maxDiscountCap),
      minSubtotal: blank(zo.minSubtotal) || zo.minSubtotal == null ? null : Number(zo.minSubtotal),
      currency: zo.currency || null,
    }));
  }
  if (Array.isArray(payload.couponCodes)) {
    // Only fields actually sent are kept, so re-sending an existing code as { code }
    // during an edit does not wipe its customer, limits or dates.
    const numOrNull = (v) => (blank(v) || v == null ? null : Number(v));
    const dateOrNull = (v) => (blank(v) || v == null ? null : v);
    out.couponCodes = payload.couponCodes.map((cc = {}) => {
      const row = { code: String(cc.code ?? '').trim().toUpperCase() };
      if ('codeType' in cc) row.codeType = cc.codeType || 'shared';
      if ('customerId' in cc) row.customerId = numOrNull(cc.customerId);
      if ('partnerRef' in cc) row.partnerRef = cc.partnerRef || null;
      if ('usageLimit' in cc) row.usageLimit = numOrNull(cc.usageLimit);
      if ('perCustomerLimit' in cc) row.perCustomerLimit = numOrNull(cc.perCustomerLimit);
      if ('activationDate' in cc) row.activationDate = dateOrNull(cc.activationDate);
      if ('expiryDate' in cc) row.expiryDate = dateOrNull(cc.expiryDate);
      return row;
    });
  }
  return out;
}

const isPositiveIntOrNull = (v) => v == null || (Number.isInteger(v) && v >= 1);
const isMoneyOrNull = (v) => v == null || (Number.isFinite(v) && v >= 0);

/** Validate the merged (stored + incoming) promotion. Throws ValidationError. */
function validatePromotion(p) {
  if (!p.name) throw new ValidationError('Promotion name is required');
  if (String(p.name).length > 200) throw new ValidationError('Promotion name is too long (max 200)');
  if (!SUPPORTED_BENEFIT_TYPES.includes(p.benefitType)) {
    throw new ValidationError(`Benefit type "${p.benefitType}" is not supported`);
  }
  if (p.discountMode != null && !['percent', 'amount'].includes(p.discountMode)) {
    throw new ValidationError('discountMode must be percent or amount');
  }
  const mode = resolveDiscountMode(p);
  if (p.benefitType !== 'free_delivery') {
    if (p.discountValue == null || !Number.isFinite(p.discountValue)) throw new ValidationError('Discount value is required');
    if (p.benefitType === 'fixed_price') {
      if (p.discountValue < 0) throw new ValidationError('Fixed price cannot be negative');
    } else if (p.discountValue <= 0) {
      throw new ValidationError('Discount value must be greater than 0');
    }
    if (mode === 'percent' && p.benefitType !== 'fixed_price' && p.discountValue > 100) {
      throw new ValidationError('A percentage cannot exceed 100%');
    }
  }
  for (const key of DECIMAL_FIELDS) {
    if (!isMoneyOrNull(p[key])) throw new ValidationError(`${key} must be a number ≥ 0`);
  }
  if (p.minSubtotal != null && p.maxSubtotal != null && p.minSubtotal > p.maxSubtotal) {
    throw new ValidationError('Minimum subtotal cannot be above maximum subtotal');
  }
  for (const key of ['globalUsageLimit', 'perCustomerLimit', 'perDayLimit', 'perWeekLimit', 'minQuantity']) {
    if (!isPositiveIntOrNull(p[key])) throw new ValidationError(`${key} must be a whole number ≥ 1, or empty for no limit`);
  }
  if (p.priority != null && (!Number.isInteger(p.priority) || p.priority < 0 || p.priority > 1000)) {
    throw new ValidationError('Priority must be a whole number between 0 and 1000');
  }

  if (p.benefitType === 'first_x_orders_discount') {
    const n = Number(p.benefitConfig?.firstOrders);
    if (!Number.isInteger(n) || n < 1) throw new ValidationError('first_x_orders_discount needs benefitConfig.firstOrders ≥ 1');
  }
  if (p.benefitType === 'bundle' && Array.isArray(p.benefitConfig?.deals)) {
    const deals = p.benefitConfig.deals;
    if (deals.length > 20) throw new ValidationError('A bulk offer can have at most 20 deals');
    const seen = new Set();
    deals.forEach((d, i) => {
      const n = i + 1;
      if (!d.itemIds || !d.itemIds.length) throw new ValidationError(`Deal ${n}: choose at least one item`);
      if (!Number.isInteger(d.quantity) || d.quantity < 2 || d.quantity > 1000) {
        throw new ValidationError(`Deal ${n}: how many pieces must be a whole number from 2 to 1000`);
      }
      if (!Number.isFinite(d.price) || d.price <= 0) throw new ValidationError(`Deal ${n}: enter the price for these pieces`);
      for (const id of d.itemIds) {
        if (seen.has(id)) throw new ValidationError(`Deal ${n}: an item can be in only one deal`);
        seen.add(id);
      }
    });
  }
  if (p.benefitType === 'bundle') {
    const n = Number(p.benefitConfig?.bundleQuantity);
    if (!Number.isInteger(n) || n < 2 || n > 1000) {
      throw new ValidationError('Bulk price needs how many pieces are in the deal (a whole number from 2 to 1000)');
    }
  }
  if (ITEM_TYPES.includes(p.benefitType)) {
    if (TARGET_TYPE_PICKED.includes(p.benefitType) && !['all', 'subCategory', 'addon', 'category', 'service'].includes(p.targetType)) {
      const what = p.benefitType === 'bundle' ? 'Bulk price' : 'Item discount';
      throw new ValidationError(`${what} needs a target type (item, add-on, category, service or all)`);
    }
    const needsIds = !(TARGET_TYPE_PICKED.includes(p.benefitType) && p.targetType === 'all');
    if (needsIds && (!Array.isArray(p.targetIds) || !p.targetIds.length || p.targetIds.some((x) => !Number.isInteger(x) || x <= 0))) {
      throw new ValidationError('Choose at least one target for this discount');
    }
  }

  if (!['all', 'selected', 'excluded'].includes(p.zoneScopeMode)) throw new ValidationError('Invalid zoneScopeMode');
  if (p.zoneScopeMode !== 'all') {
    // Coerce string/JSON zone ids (common after admin UI round-trips) before rejecting.
    const zoneIds = asIntIdList(p.zoneIds);
    p.zoneIds = zoneIds.length ? zoneIds : p.zoneIds;
    if (!zoneIds.length) {
      throw new ValidationError('Select at least one zone');
    }
  }
  if (!['automatic', 'coupon_required'].includes(p.activationType)) throw new ValidationError('Invalid activationType');
  if (!['public', 'private_code', 'targeted', 'hidden'].includes(p.visibility)) throw new ValidationError('Invalid visibility');
  if (!['recalculate', 'revalidate', 'lock'].includes(p.repricingPolicy)) throw new ValidationError('Invalid repricingPolicy');

  const start = p.startDate ? new Date(p.startDate) : null;
  const end = p.endDate ? new Date(p.endDate) : null;
  if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) throw new ValidationError('Invalid start or end date');
  if (start && end && end <= start) throw new ValidationError('End date must be after the start date');

  if (p.recurringStartTime === '__invalid__' || p.recurringEndTime === '__invalid__') throw new ValidationError('Recurring times must be HH:MM');
  if ((p.recurringStartTime == null) !== (p.recurringEndTime == null)) throw new ValidationError('Set both recurring start and end time');
  if (p.recurringDays != null && (!Array.isArray(p.recurringDays) || p.recurringDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) {
    throw new ValidationError('Recurring days must be weekdays 0-6');
  }

  for (const c of p.conditions || []) {
    const err = validateCondition(c);
    if (err) throw new ValidationError(err);
  }

  const zoneOverrideIds = new Set();
  for (const zo of p.zoneOverrides || []) {
    if (!Number.isInteger(zo.zoneId) || zo.zoneId <= 0) throw new ValidationError('Zone override needs a zone');
    if (zoneOverrideIds.has(zo.zoneId)) throw new ValidationError('Only one override per zone');
    zoneOverrideIds.add(zo.zoneId);
    if (!isMoneyOrNull(zo.discountValue) || !isMoneyOrNull(zo.maxDiscountCap) || !isMoneyOrNull(zo.minSubtotal)) {
      throw new ValidationError('Zone override values must be numbers ≥ 0');
    }
    if (zo.discountValue != null && mode === 'percent' && zo.discountValue > 100) {
      throw new ValidationError('Zone override percentage cannot exceed 100%');
    }
  }

  const codes = new Set();
  for (const cc of p.couponCodes || []) {
    if (!cc.code || !/^[A-Z0-9_-]{3,30}$/.test(cc.code)) {
      throw new ValidationError(`Coupon code "${cc.code}" must be 3–30 letters, numbers, - or _`);
    }
    if (codes.has(cc.code)) throw new ValidationError(`Coupon code "${cc.code}" is listed twice`);
    codes.add(cc.code);
    if (!['shared', 'unique', 'customer_bound', 'partner', 'bulk'].includes(cc.codeType || 'shared')) throw new ValidationError('Invalid coupon codeType');
    if (cc.codeType === 'customer_bound' && !cc.customerId) throw new ValidationError(`Coupon "${cc.code}" is customer-bound but has no customer`);
    if (!isPositiveIntOrNull(cc.usageLimit) || !isPositiveIntOrNull(cc.perCustomerLimit)) {
      throw new ValidationError(`Coupon "${cc.code}" limits must be whole numbers ≥ 1`);
    }
  }
  if (p.activationType === 'coupon_required' && p.couponCodes && !p.couponCodes.length) {
    throw new ValidationError('A coupon-required promotion needs at least one coupon code');
  }
}

// ─── Offer budget ────────────────────────────────────────────────────────────

/**
 * payload.budget (£, or empty for none): the offer's own budget. It is a budget pool that
 * belongs to this offer (campaigns.ownerPromotionId), so the engine has one budget rule for
 * own and shared budgets. Returns undefined when not sent, null for none, else pence.
 */
function budgetMinorOf(payload = {}) {
  if (!('budget' in payload)) return undefined;
  const v = payload.budget;
  if (blank(v) || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ValidationError('Budget must be more than £0, or left empty for no budget');
  if (n > 1000000) throw new ValidationError('Budget is too large');
  return Math.round(n * 100);
}

async function ownBudgetOf(promo, t) {
  if (!promo.campaignId) return null;
  const camp = await Campaign.findByPk(promo.campaignId, { transaction: t });
  return camp && Number(camp.ownerPromotionId) === Number(promo.id) ? camp : null;
}

/** Create, change or remove the offer's own budget. A shared budget and an own one exclude each other. */
async function syncOwnBudget(promo, budgetMinor, adminUserId, t) {
  if (budgetMinor === undefined) return;
  const own = await ownBudgetOf(promo, t);
  if (budgetMinor == null) {
    if (own) await promo.update({ campaignId: null }, { transaction: t });
    return;
  }
  if (own) {
    if (own.budgetMinor !== budgetMinor) await own.update({ budgetMinor, updatedBy: adminUserId }, { transaction: t });
    return;
  }
  if (promo.campaignId) {
    throw new ValidationError('This offer uses a shared budget. Remove it from the shared budget to give it its own.');
  }
  const camp = await Campaign.create({
    name: `${promo.name} — budget`.slice(0, 200),
    ownerPromotionId: promo.id,
    budgetMinor,
    status: 'active',
    createdBy: adminUserId,
    updatedBy: adminUserId,
  }, { transaction: t });
  await promo.update({ campaignId: camp.id }, { transaction: t });
}

/** A promotion can only be put into (or published in) a campaign that exists and is not closed. */
async function assertCampaignUsable(campaignId, transaction, ownerOk = false) {
  if (campaignId == null) return;
  if (!Number.isInteger(campaignId) || campaignId <= 0) throw new ValidationError('Invalid campaign');
  const row = await Campaign.findByPk(campaignId, { attributes: ['id', 'name', 'status', 'ownerPromotionId'], transaction });
  if (!row) throw new ValidationError('Campaign not found');
  if (row.ownerPromotionId != null && !ownerOk) throw new ValidationError('That budget belongs to another offer. Choose a shared budget.');
  if (CLOSED_STATUSES.includes(row.status)) {
    throw new ValidationError(`Campaign "${row.name}" is ${row.status}. Choose another campaign or no campaign.`);
  }
}

/**
 * One name per promotion, so admins can tell them apart in the list. Archived promotions
 * don't count (their name can be used again). The database compares without letter case.
 */
async function assertNameAvailable(name, exceptId, transaction) {
  const clean = String(name ?? '').trim();
  if (!clean) return;
  const clash = await Promotion.findOne({
    where: { name: clean, status: { [Op.ne]: 'archived' }, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
    attributes: ['id'],
    transaction,
  });
  if (clash) throw new ValidationError(`A promotion called "${clean}" already exists. Choose a different name.`);
}

/** Coupon codes must be unique across all promotions. */
async function assertCodesAvailable(codes, promotionId, transaction) {
  if (!codes.length) return;
  // Codes of archived promotions are released (releasedAt) and may be used again.
  const taken = await CouponCode.findAll({
    where: { code: codes, releasedAt: null, ...(promotionId ? { promotionId: { [Op.ne]: promotionId } } : {}) },
    attributes: ['code'],
    transaction,
  });
  if (taken.length) throw new ValidationError(`Coupon code "${taken[0].code}" is already used by another promotion`);
  // Only codes new to this promotion, so an old overlap does not block unrelated edits.
  const own = promotionId
    ? (await CouponCode.findAll({ where: { promotionId }, attributes: ['code'], transaction })).map((c) => c.code)
    : [];
  const added = codes.filter((c) => !own.includes(c));
  if (added.length) await assertNotLegacyCoupon(added, transaction);
}

/** Legacy coupons (coupons table) share the customer's code box, so a code may live in only one system. */
async function assertNotLegacyCoupon(codes, transaction) {
  const legacy = await LegacyCoupon.findOne({ where: { code: codes }, attributes: ['code'], transaction });
  if (legacy) {
    throw new ValidationError(`Code "${legacy.code}" is already used in Coupons (Legacy). Please use a different code.`);
  }
}

/** Zone staff: promotion can only target their own zone. */
function applyZoneRestriction(data, scope) {
  const zoneId = restrictedZoneOf(scope);
  if (zoneId == null) return data;
  return {
    ...data,
    zoneScopeMode: 'selected',
    zoneIds: [zoneId],
    ...(data.zoneOverrides ? { zoneOverrides: data.zoneOverrides.filter((zo) => zo.zoneId === zoneId) } : {}),
  };
}

/** Stored promotion (+ loaded children) in the same shape normalizePayload produces. */
function rowData(row) {
  const o = row.toJSON();
  const num = (v) => (v == null ? null : Number(v));
  for (const key of DECIMAL_FIELDS) o[key] = num(o[key]);
  o.zoneIds = o.zoneIds == null ? null : asIntIdList(o.zoneIds);
  o.targetIds = o.targetIds == null ? null : asIntIdList(o.targetIds);
  o.recurringDays = o.recurringDays == null ? null : asIntIdList(o.recurringDays);
  if (Array.isArray(o.zoneOverrides)) {
    o.zoneOverrides = o.zoneOverrides.map((zo) => ({
      zoneId: Number(zo.zoneId), discountValue: num(zo.discountValue), maxDiscountCap: num(zo.maxDiscountCap), minSubtotal: num(zo.minSubtotal), currency: zo.currency,
    }));
  }
  if (Array.isArray(o.couponCodes)) {
    o.couponCodes = o.couponCodes.filter((c) => c.isActive).map((c) => ({
      code: c.code, codeType: c.codeType || 'shared', customerId: c.customerId ?? null, usageLimit: c.usageLimit ?? null, perCustomerLimit: c.perCustomerLimit ?? null,
    }));
  }
  return o;
}

function columnsOf(data) {
  const out = {};
  for (const key of SCALAR_FIELDS) if (key in data) out[key] = data[key];
  return out;
}

async function writeChildren(promotionId, data, adminUserId, t, { replace }) {
  if (Array.isArray(data.conditions)) {
    if (replace) await PromotionCondition.destroy({ where: { promotionId }, transaction: t });
    for (const c of data.conditions) {
      await PromotionCondition.create({ promotionId, ...c }, { transaction: t });
    }
  }
  if (Array.isArray(data.zoneOverrides)) {
    if (replace) await PromotionZoneOverride.destroy({ where: { promotionId }, transaction: t });
    for (const zo of data.zoneOverrides) {
      await PromotionZoneOverride.create({ promotionId, ...zo }, { transaction: t });
    }
  }
  if (Array.isArray(data.couponCodes)) {
    await assertCodesAvailable(data.couponCodes.map((c) => c.code), promotionId, t);
    const existing = replace ? await CouponCode.findAll({ where: { promotionId }, transaction: t }) : [];
    const wanted = new Map(data.couponCodes.map((c) => [c.code, c]));
    for (const row of existing) {
      const next = wanted.get(row.code);
      if (next) {
        await row.update({ ...next, isActive: true }, { transaction: t });
        wanted.delete(row.code);
      } else if (row.usedCount > 0) {
        await row.update({ isActive: false }, { transaction: t });
      } else {
        await row.destroy({ transaction: t });
      }
    }
    for (const cc of wanted.values()) {
      await CouponCode.create({ promotionId, codeType: 'shared', ...cc, isActive: true, createdBy: adminUserId }, { transaction: t });
    }
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

async function createPromotion(payload, adminUserId, scope) {
  const data = applyZoneRestriction({ ...DEFAULTS, ...normalizePayload(payload) }, scope);
  if (data.discountMode == null && data.benefitType !== 'free_delivery') data.discountMode = resolveDiscountMode(data);
  Object.assign(data, typeRuleFields(data));
  assertNoOrderHistoryCondition(data.benefitType, data.conditions);
  validatePromotion(data);
  await assertNameAvailable(data.name);
  await assertCampaignUsable(data.campaignId);
  const budgetMinor = budgetMinorOf(payload);
  if (budgetMinor != null && data.campaignId != null) {
    throw new ValidationError("Choose either a shared budget or the offer's own budget, not both.");
  }

  const promoId = await sequelize.transaction(async (t) => {
    const promo = await Promotion.create({
      ...columnsOf(data),
      status: 'draft',
      globalUsedCount: 0,
      globalReservedCount: 0,
      currentVersionId: null,
      createdBy: adminUserId,
      updatedBy: adminUserId,
    }, { transaction: t });
    await writeChildren(promo.id, data, adminUserId, t, { replace: false });
    await syncOwnBudget(promo, budgetMinor, adminUserId, t);
    await audit(promo.id, 'created', adminUserId, { newValue: promo.toJSON() }, t);
    return promo.id;
  });
  return getPromotionById(promoId);
}

/** bookedCount: orders holding the promotion that get money off (or are not priced yet). */
async function withBookedCount(rows) {
  if (!rows.length) return;
  const [counts] = await sequelize.query(
    `SELECT r.promotionId AS id, COUNT(*) AS n FROM promotion_redemptions r
      WHERE r.promotionId IN (:ids) AND ${BOOKED_HOLD_SQL('r')} GROUP BY r.promotionId`,
    { replacements: { ids: rows.map((r) => r.id), now: new Date() } }
  );
  const byId = new Map(counts.map((c) => [Number(c.id), Number(c.n)]));
  for (const row of rows) row.setDataValue('bookedCount', byId.get(Number(row.id)) || 0);
}

async function listPromotions({ page = 1, limit = 50, status, campaignId, benefitType, search } = {}, scope) {
  const where = {};
  if (status) where.status = status;
  if (campaignId) where.campaignId = Number(campaignId);
  if (benefitType) where.benefitType = benefitType;
  if (search) where.name = { [Op.like]: `%${String(search).replace(/[%_]/g, '\\$&')}%` };
  const zoneId = restrictedZoneOf(scope);
  if (zoneId != null) {
    where.zoneScopeMode = 'selected';
    where[Op.and] = [literal(`JSON_CONTAINS(\`promotion\`.\`zoneIds\`, '${zoneId}')`)];
  }

  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const { count, rows } = await Promotion.findAndCountAll({
    where,
    order: [['id', 'DESC']],
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
    distinct: true,
    include: [
      { model: CouponCode, as: 'couponCodes', attributes: ['id', 'code', 'usedCount', 'isActive'] },
      { model: Campaign, as: 'campaign', attributes: CAMPAIGN_SUMMARY },
      // The list says who an offer is for ("First order"), so it needs the rule types.
      { model: PromotionCondition, as: 'conditions', attributes: ['id', 'promotionId', 'conditionType'], separate: true },
    ],
  });

  await withCampaignStop(rows);
  await withBookedCount(rows);
  return { count, rows, page: safePage, limit: safeLimit };
}

async function getPromotionById(id, scope) {
  const row = await Promotion.findByPk(id, { include: FULL_INCLUDE });
  if (!row) throw new NotFoundError('Promotion not found');
  assertInScope(row, scope);
  return row;
}

async function updatePromotion(id, payload, adminUserId, scope) {
  const promo = await Promotion.findByPk(id, {
    include: [{
      model: CouponCode,
      as: 'couponCodes',
      attributes: ['code', 'codeType', 'customerId', 'partnerRef', 'usageLimit', 'perCustomerLimit', 'activationDate', 'expiryDate', 'isActive'],
    }],
  });
  if (!promo) throw new NotFoundError('Promotion not found');
  assertInScope(promo, scope);

  if (LIVE_STATUSES.includes(promo.status)) return updateLiveOffer(promo, payload, adminUserId);
  if (!EDITABLE.includes(promo.status)) {
    throw new ValidationError(`Cannot edit promotion in "${promo.status}" status. Pause it first.`);
  }

  const incoming = applyZoneRestriction(normalizePayload(payload), scope);
  if (incoming.couponCodes) {
    // Codes re-sent without details keep their stored customer, limits and dates
    const byCode = new Map((promo.couponCodes || []).map((c) => [c.code, c.toJSON()]));
    incoming.couponCodes = incoming.couponCodes.map((cc) => {
      const prev = byCode.get(cc.code);
      if (!prev) return cc;
      const { isActive, ...rest } = prev;
      return { ...rest, ...cc };
    });
  }
  const stored = rowData(promo);
  // A benefit type with a fixed mode (e.g. fixed_amount_discount) drags discountMode along
  if (incoming.benefitType && incoming.discountMode === undefined && incoming.benefitType !== 'free_delivery') {
    incoming.discountMode = resolveDiscountMode({ ...stored, ...incoming, discountMode: stored.discountMode });
  }
  // Orders may already hold a published promotion under its type: the type stays.
  if (incoming.benefitType && incoming.benefitType !== promo.benefitType && promo.currentVersionId) {
    throw new ValidationError('The type of a promotion cannot be changed after it has been published. Create a new promotion for a different type.');
  }
  Object.assign(incoming, typeRuleFields({ ...stored, ...incoming }));
  // A new type is checked against the stored conditions too, when none are re-sent.
  assertNoOrderHistoryCondition(
    incoming.benefitType || stored.benefitType,
    incoming.conditions || (incoming.benefitType ? stored.conditions : null)
  );
  // Conditions/overrides are validated only when sent; coupons always (coupon_required needs one)
  validatePromotion({ ...stored, conditions: undefined, zoneOverrides: undefined, ...incoming });
  // Only a changed name is checked, so older promotions that share a name can still be edited.
  if (incoming.name && incoming.name.trim() !== promo.name) await assertNameAvailable(incoming.name, promo.id);
  if (incoming.campaignId != null && incoming.campaignId !== promo.campaignId) await assertCampaignUsable(incoming.campaignId);
  const budgetMinor = budgetMinorOf(payload);
  // Moving to a shared budget (or out of one) while keeping an own budget is not possible.
  if ('campaignId' in incoming && incoming.campaignId !== promo.campaignId) {
    const ownNow = await ownBudgetOf(promo);
    if (ownNow && incoming.campaignId != null && budgetMinor != null) {
      throw new ValidationError("Choose either a shared budget or the offer's own budget, not both.");
    }
    // Clearing the shared budget must not drop the own one by accident.
    if (ownNow && incoming.campaignId == null) delete incoming.campaignId;
  }

  const oldValue = promo.toJSON();
  await sequelize.transaction(async (t) => {
    await promo.update({ ...columnsOf(incoming), updatedBy: adminUserId }, { transaction: t });
    await writeChildren(id, incoming, adminUserId, t, { replace: true });
    await syncOwnBudget(promo, budgetMinor, adminUserId, t);
    await audit(id, 'updated', adminUserId, { oldValue, newValue: promo.toJSON() }, t);
  });
  return getPromotionById(id);
}

/**
 * Change a live offer without pausing it: name, end date, limits and budget. These never
 * change what an order already booked gets. The discount, who gets it and what it is on
 * need a pause, so customers are never shown one offer and given another.
 */
async function updateLiveOffer(promo, payload, adminUserId) {
  const sent = Object.keys(payload || {}).filter((k) => payload[k] !== undefined && k !== 'id');
  const blocked = sent.filter((k) => !LIVE_EDITABLE.includes(k));
  if (blocked.length) {
    throw new ValidationError('While an offer is live you can change its name, end date, limits and budget. Pause it to change anything else.');
  }
  const incoming = normalizePayload(payload);
  if ('name' in incoming && !incoming.name) throw new ValidationError('Offer name is required');
  if (incoming.name && incoming.name.trim() !== promo.name) await assertNameAvailable(incoming.name, promo.id);
  if ('endDate' in incoming && incoming.endDate != null) {
    if (new Date(incoming.endDate) < new Date()) throw new ValidationError('The end date has already passed. To stop the offer now, pause it.');
    if (promo.startDate && new Date(incoming.endDate) < new Date(promo.startDate)) throw new ValidationError('The end date is before the start date');
  }
  const taken = (promo.globalUsedCount || 0) + (promo.globalReservedCount || 0);
  if ('globalUsageLimit' in incoming && incoming.globalUsageLimit != null) {
    if (!isPositiveIntOrNull(incoming.globalUsageLimit)) throw new ValidationError('Total orders must be a whole number of 1 or more');
    if (incoming.globalUsageLimit < taken) {
      throw new ValidationError(`${taken} orders already have this offer, so the total can't be lower than ${taken}.`);
    }
  }
  if ('perCustomerLimit' in incoming && !isPositiveIntOrNull(incoming.perCustomerLimit)) {
    throw new ValidationError('Uses per customer must be a whole number of 1 or more');
  }
  const budgetMinor = budgetMinorOf(payload);

  const oldValue = promo.toJSON();
  await sequelize.transaction(async (t) => {
    await promo.update({ ...columnsOf(incoming), updatedBy: adminUserId }, { transaction: t });
    await syncOwnBudget(promo, budgetMinor, adminUserId, t);
    await audit(promo.id, 'updated_live', adminUserId, { oldValue, newValue: promo.toJSON() }, t);
  });
  return getPromotionById(promo.id);
}

// ─── Lifecycle transitions ───────────────────────────────────────────────────

async function changeStatus(id, newStatus, adminUserId, reason, scope) {
  const promo = await Promotion.findByPk(id);
  if (!promo) throw new NotFoundError('Promotion not found');
  assertInScope(promo, scope);

  const oldStatus = promo.status;
  if (['active', 'scheduled'].includes(newStatus)) {
    throw new ValidationError('Use Publish to make a promotion live');
  }
  if (!canTransition(oldStatus, newStatus)) {
    throw new ValidationError(`Cannot change status from "${oldStatus}" to "${newStatus}"`);
  }

  await sequelize.transaction(async (t) => {
    await promo.update({ status: newStatus, updatedBy: adminUserId }, { transaction: t });
    // Archived is final, so its codes are given back for new promotions. Orders keep their
    // couponCodeId, so history stays with this promotion.
    if (newStatus === 'archived') {
      await CouponCode.update({ releasedAt: new Date() }, { where: { promotionId: id, releasedAt: null }, transaction: t });
    }
    await audit(id, `status_${newStatus}`, adminUserId, {
      oldValue: { status: oldStatus }, newValue: { status: newStatus }, reason: reason || null,
    }, t);
  });
  return promo.reload();
}

/** Immutable snapshot of everything the engine reads. */
function buildSnapshot(promo) {
  const plain = promo.toJSON();
  const snapshot = {};
  for (const key of SCALAR_FIELDS) snapshot[key] = plain[key] ?? null;
  snapshot.conditions = (plain.conditions || []).map((c) => ({
    conditionType: c.conditionType, operator: c.operator, value: c.value, logicGroup: c.logicGroup, sortOrder: c.sortOrder,
  }));
  snapshot.zoneOverrides = (plain.zoneOverrides || []).map((zo) => ({
    zoneId: zo.zoneId, discountValue: zo.discountValue, maxDiscountCap: zo.maxDiscountCap, minSubtotal: zo.minSubtotal, currency: zo.currency, isActive: zo.isActive,
  }));
  snapshot.couponCodes = (plain.couponCodes || []).filter((c) => c.isActive).map((c) => c.code);
  return snapshot;
}

async function publishPromotion(id, adminUserId, reason, scope) {
  const promo = await getPromotionById(id, scope);

  if (!PUBLISHABLE.includes(promo.status)) {
    throw new ValidationError(`Cannot publish from "${promo.status}" status`);
  }
  const now = new Date();
  if (promo.endDate && new Date(promo.endDate) <= now) {
    throw new ValidationError('This promotion has already ended — change the end date first');
  }
  validatePromotion(rowData(promo));
  await assertCampaignUsable(promo.campaignId, undefined, true);
  const status = promo.startDate && new Date(promo.startDate) > now ? 'scheduled' : 'active';

  await sequelize.transaction(async (t) => {
    const maxVersion = await PromotionVersion.max('versionNumber', { where: { promotionId: id }, transaction: t });
    const nextVersion = (maxVersion || 0) + 1;
    const version = await PromotionVersion.create({
      promotionId: id,
      versionNumber: nextVersion,
      configSnapshot: buildSnapshot(promo),
      publishedAt: now,
      publishedBy: adminUserId,
      reason: reason || `Published as version ${nextVersion}`,
    }, { transaction: t });

    await promo.update({ status, currentVersionId: version.id, updatedBy: adminUserId }, { transaction: t });
    await audit(id, 'published', adminUserId, { newValue: { versionNumber: nextVersion, status }, reason: reason || null }, t);
  });

  return getPromotionById(id);
}

async function pausePromotion(id, adminUserId, reason, scope) {
  return changeStatus(id, 'paused', adminUserId, reason, scope);
}

async function archivePromotion(id, adminUserId, reason, scope) {
  return changeStatus(id, 'archived', adminUserId, reason, scope);
}

// ─── Coupon code management ─────────────────────────────────────────────────

async function addCouponCode(promotionId, payload, adminUserId, scope) {
  const promo = await Promotion.findByPk(promotionId);
  if (!promo) throw new NotFoundError('Promotion not found');
  assertInScope(promo, scope);

  const [cc] = normalizePayload({ couponCodes: [payload || {}] }).couponCodes;
  validatePromotion({ ...rowData(promo), couponCodes: [cc] });
  const existing = await CouponCode.findOne({ where: { code: cc.code, releasedAt: null } });
  if (existing) throw new ValidationError(`Coupon code "${cc.code}" already exists`);
  await assertNotLegacyCoupon([cc.code]);

  const row = await CouponCode.create({ promotionId, ...cc, isActive: true, createdBy: adminUserId });
  await audit(Number(promotionId), 'coupon_added', adminUserId, { newValue: { code: row.code } });
  return row;
}

async function removeCouponCode(couponCodeId, adminUserId, scope) {
  const row = await CouponCode.findByPk(couponCodeId, { include: [{ model: Promotion, as: 'promotion' }] });
  if (!row) throw new NotFoundError('Coupon code not found');
  if (row.promotion) assertInScope(row.promotion, scope);

  if (row.usedCount > 0) {
    await row.update({ isActive: false });
    await audit(row.promotionId, 'coupon_deactivated', adminUserId, { oldValue: { code: row.code } });
    return { deactivated: true };
  }

  await row.destroy();
  await audit(row.promotionId, 'coupon_deleted', adminUserId, { oldValue: { code: row.code } });
  return { deleted: true };
}

// ─── Clone / duplicate ──────────────────────────────────────────────────────

async function clonePromotion(id, adminUserId, scope) {
  const source = await getPromotionById(id, scope);
  const plain = source.toJSON();
  const payload = {};
  for (const key of SCALAR_FIELDS) payload[key] = plain[key];
  // A free name: "X (Copy)", then "X (Copy 2)", "X (Copy 3)"…
  payload.name = `${source.name} (Copy)`.slice(0, 200);
  for (let n = 2; n < 100; n += 1) {
    const used = await Promotion.findOne({ where: { name: payload.name, status: { [Op.ne]: 'archived' } }, attributes: ['id'] });
    if (!used) break;
    payload.name = `${source.name} (Copy ${n})`.slice(0, 200);
  }
  payload.conditions = (plain.conditions || []).map((c) => ({
    conditionType: c.conditionType, operator: c.operator, value: c.value, logicGroup: c.logicGroup, sortOrder: c.sortOrder,
  }));
  payload.zoneOverrides = (plain.zoneOverrides || []).map((zo) => ({
    zoneId: zo.zoneId, discountValue: zo.discountValue, maxDiscountCap: zo.maxDiscountCap, minSubtotal: zo.minSubtotal, currency: zo.currency,
  }));
  // Codes are unique: the copy starts without codes (and therefore as automatic if it needed one)
  payload.couponCodes = [];
  if (payload.activationType === 'coupon_required') payload.activationType = 'automatic';
  // A copy of a promotion from a closed campaign starts outside any campaign.
  if (payload.campaignId != null) {
    const camp = await Campaign.findByPk(payload.campaignId, { attributes: ['status', 'ownerPromotionId', 'budgetMinor'] });
    if (camp && camp.ownerPromotionId != null) {
      // Its own budget is not shared: the copy gets a fresh budget of the same size.
      payload.campaignId = null;
      if (camp.budgetMinor != null) payload.budget = camp.budgetMinor / 100;
    } else if (!camp || CLOSED_STATUSES.includes(camp.status)) payload.campaignId = null;
  }
  return createPromotion(payload, adminUserId, scope);
}

// ─── Analytics (basic) ──────────────────────────────────────────────────────

async function getPromotionAnalytics(id, scope, query = {}) {
  const { promotionRedemption: Redemption } = require('../../models');
  const promo = await Promotion.findByPk(id);
  if (!promo) throw new NotFoundError('Promotion not found');
  assertInScope(promo, scope);

  const now = new Date();
  const [committed, reserved, reversed, released] = await Promise.all([
    Redemption.count({ where: { promotionId: id, status: 'COMMITTED' } }),
    Redemption.count({ where: { promotionId: id, status: 'RESERVED', reservationExpiresAt: { [Op.gt]: now } } }),
    Redemption.count({ where: { promotionId: id, status: 'REVERSED' } }),
    Redemption.count({ where: { promotionId: id, status: 'RELEASED' } }),
  ]);

  const totalDiscount = await Redemption.sum('discountAmount', { where: { promotionId: id, status: 'COMMITTED' } });
  const uniqueCustomers = await Redemption.count({
    where: { promotionId: id, status: 'COMMITTED' },
    distinct: true,
    col: 'customerId',
  });

  return {
    promotionId: Number(id),
    name: promo.name,
    status: promo.status,
    redemptions: { committed, reserved, reversed, released },
    totalDiscount: Number(totalDiscount || 0).toFixed(2),
    uniqueCustomers,
    globalUsedCount: promo.globalUsedCount,
    globalUsageLimit: promo.globalUsageLimit,
    // Full report (Phase 5): by zone / day / code, recent uses, refunds, holds.
    report: await require('../promotions/promotionReportService').promotionReport(id, {
      from: query.from,
      to: query.to,
      inRange: query.inRange,
      recentLimit: query.recentLimit,
      restrictedZoneId: restrictedZoneOf(scope),
    }),
  };
}

/** Live promotions the admin can see, for conflict warnings. */
async function listLivePromotions(scope) {
  const where = { status: { [Op.in]: ['active', 'scheduled'] } };
  const zoneId = restrictedZoneOf(scope);
  const rows = await Promotion.findAll({ where });
  return zoneId == null ? rows : rows.filter((p) => {
    if (p.zoneScopeMode === 'all') return true;
    const ids = Array.isArray(p.zoneIds) ? p.zoneIds.map(Number) : [];
    return p.zoneScopeMode === 'selected' ? ids.includes(zoneId) : !ids.includes(zoneId);
  });
}

module.exports = {
  createPromotion,
  listPromotions,
  getPromotionById,
  updatePromotion,
  changeStatus,
  publishPromotion,
  pausePromotion,
  archivePromotion,
  addCouponCode,
  removeCouponCode,
  clonePromotion,
  getPromotionAnalytics,
  listLivePromotions,
  restrictedZoneOf,
  // exported for tests
  normalizePayload,
  validatePromotion,
  typeRuleFields,
  assertNoOrderHistoryCondition,
  TRANSITIONS,
};

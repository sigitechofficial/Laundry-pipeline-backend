'use strict';

const { Op, literal } = require('sequelize');
const {
  promotion: Promotion,
  promotionVersion: PromotionVersion,
  promotionCondition: PromotionCondition,
  promotionZoneOverride: PromotionZoneOverride,
  couponCode: CouponCode,
  promotionAuditLog: AuditLog,
  sequelize,
} = require('../../models');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../middlewares/universalErrorHandler');
const { SUPPORTED_BENEFIT_TYPES, resolveDiscountMode } = require('../promotions/benefitHandlers');
const { validateCondition } = require('../promotions/conditionEvaluator');
const { normalizeHHMM } = require('../promotions/promotionTime');

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
const ITEM_TYPES = ['item_discount', 'category_discount', 'service_discount'];
const DEFAULTS = {
  currency: 'GBP', targetType: 'basket', zoneScopeMode: 'all', activationType: 'automatic', visibility: 'hidden',
  priority: 50, stackable: false, perCustomerLimit: 1, repricingPolicy: 'recalculate',
};

const blank = (v) => v === '' || v === undefined;

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
    if ((key === 'recurringStartTime' || key === 'recurringEndTime') && v != null) v = normalizeHHMM(v) || '__invalid__';
    if ((key === 'targetIds' || key === 'zoneIds' || key === 'recurringDays') && Array.isArray(v)) v = [...new Set(v.map(Number))];
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
  if (ITEM_TYPES.includes(p.benefitType)) {
    if (p.benefitType === 'item_discount' && !['all', 'subCategory', 'addon', 'category', 'service'].includes(p.targetType)) {
      throw new ValidationError('Item discount needs a target type (item, add-on, category, service or all)');
    }
    const needsIds = !(p.benefitType === 'item_discount' && p.targetType === 'all');
    if (needsIds && (!Array.isArray(p.targetIds) || !p.targetIds.length || p.targetIds.some((x) => !Number.isInteger(x) || x <= 0))) {
      throw new ValidationError('Choose at least one target for this discount');
    }
  }

  if (!['all', 'selected', 'excluded'].includes(p.zoneScopeMode)) throw new ValidationError('Invalid zoneScopeMode');
  if (p.zoneScopeMode !== 'all' && (!Array.isArray(p.zoneIds) || !p.zoneIds.length || p.zoneIds.some((z) => !Number.isInteger(z) || z <= 0))) {
    throw new ValidationError('Select at least one zone');
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
    if (!cc.code || !/^[A-Z0-9_-]{3,50}$/.test(cc.code)) {
      throw new ValidationError(`Coupon code "${cc.code}" must be 3–50 letters, numbers, - or _`);
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

/** Coupon codes must be unique across all promotions. */
async function assertCodesAvailable(codes, promotionId, transaction) {
  if (!codes.length) return;
  const taken = await CouponCode.findAll({
    where: { code: codes, ...(promotionId ? { promotionId: { [Op.ne]: promotionId } } : {}) },
    attributes: ['code'],
    transaction,
  });
  if (taken.length) throw new ValidationError(`Coupon code "${taken[0].code}" is already used by another promotion`);
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
  validatePromotion(data);

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
    await audit(promo.id, 'created', adminUserId, { newValue: promo.toJSON() }, t);
    return promo.id;
  });
  return getPromotionById(promoId);
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
    ],
  });

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
  // Conditions/overrides are validated only when sent; coupons always (coupon_required needs one)
  validatePromotion({ ...stored, conditions: undefined, zoneOverrides: undefined, ...incoming });

  const oldValue = promo.toJSON();
  await sequelize.transaction(async (t) => {
    await promo.update({ ...columnsOf(incoming), updatedBy: adminUserId }, { transaction: t });
    await writeChildren(id, incoming, adminUserId, t, { replace: true });
    await audit(id, 'updated', adminUserId, { oldValue, newValue: promo.toJSON() }, t);
  });
  return getPromotionById(id);
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
  const existing = await CouponCode.findOne({ where: { code: cc.code } });
  if (existing) throw new ValidationError(`Coupon code "${cc.code}" already exists`);

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
  payload.name = `${source.name} (Copy)`.slice(0, 200);
  payload.conditions = (plain.conditions || []).map((c) => ({
    conditionType: c.conditionType, operator: c.operator, value: c.value, logicGroup: c.logicGroup, sortOrder: c.sortOrder,
  }));
  payload.zoneOverrides = (plain.zoneOverrides || []).map((zo) => ({
    zoneId: zo.zoneId, discountValue: zo.discountValue, maxDiscountCap: zo.maxDiscountCap, minSubtotal: zo.minSubtotal, currency: zo.currency,
  }));
  // Codes are unique: the copy starts without codes (and therefore as automatic if it needed one)
  payload.couponCodes = [];
  if (payload.activationType === 'coupon_required') payload.activationType = 'automatic';
  return createPromotion(payload, adminUserId, scope);
}

// ─── Analytics (basic) ──────────────────────────────────────────────────────

async function getPromotionAnalytics(id, scope) {
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
  TRANSITIONS,
};

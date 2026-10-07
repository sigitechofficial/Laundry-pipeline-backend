'use strict';

const { Op } = require('sequelize');
const {
  promotion: Promotion,
  promotionVersion: PromotionVersion,
  promotionCondition: PromotionCondition,
  promotionZoneOverride: PromotionZoneOverride,
  couponCode: CouponCode,
  promotionAuditLog: AuditLog,
  sequelize,
} = require('../../models');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');

// ─── Audit helper ────────────────────────────────────────────────────────────

async function audit(entityId, action, actorId, extras = {}) {
  try {
    await AuditLog.create({
      entityType: 'promotion',
      entityId,
      action,
      actorId,
      actorType: actorId ? 'admin' : 'system',
      ...extras,
    });
  } catch (err) {
    console.error('[AuditLog] write fail:', err.message);
  }
}

// ─── Valid lifecycle transitions ─────────────────────────────────────────────

const TRANSITIONS = {
  draft:            ['pending_approval', 'active', 'archived'],
  pending_approval: ['approved', 'draft'],
  approved:         ['scheduled', 'active', 'archived'],
  scheduled:        ['active', 'paused', 'archived'],
  active:           ['paused', 'expired', 'archived'],
  paused:           ['active', 'archived'],
  expired:          ['archived'],
  archived:         [],
};

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// ─── Full include for detail queries ────────────────────────────────────────

const FULL_INCLUDE = [
  { model: PromotionCondition, as: 'conditions', order: [['sortOrder', 'ASC']] },
  { model: PromotionZoneOverride, as: 'zoneOverrides' },
  { model: CouponCode, as: 'couponCodes', attributes: ['id', 'code', 'codeType', 'usedCount', 'usageLimit', 'isActive'] },
  { model: PromotionVersion, as: 'versions', order: [['versionNumber', 'DESC']], limit: 10 },
];

// ─── CRUD ────────────────────────────────────────────────────────────────────

async function createPromotion(payload, adminUserId) {
  _validate(payload);
  const t = await sequelize.transaction();

  try {
    const promo = await Promotion.create({
      campaignId: payload.campaignId || null,
      name: payload.name.trim(),
      description: payload.description || null,
      internalNotes: payload.internalNotes || null,
      benefitType: payload.benefitType,
      discountValue: payload.discountValue || null,
      maxDiscountCap: payload.maxDiscountCap || null,
      currency: payload.currency || 'GBP',
      targetType: payload.targetType || 'basket',
      targetIds: payload.targetIds || null,
      zoneScopeMode: payload.zoneScopeMode || 'all',
      zoneIds: payload.zoneIds || null,
      startDate: payload.startDate || null,
      endDate: payload.endDate || null,
      recurringDays: payload.recurringDays || null,
      recurringStartTime: payload.recurringStartTime || null,
      recurringEndTime: payload.recurringEndTime || null,
      activationType: payload.activationType || 'automatic',
      visibility: payload.visibility || 'hidden',
      priority: payload.priority ?? 50,
      stackable: payload.stackable ?? false,
      stackGroup: payload.stackGroup || null,
      globalUsageLimit: payload.globalUsageLimit || null,
      perCustomerLimit: payload.perCustomerLimit ?? 1,
      perDayLimit: payload.perDayLimit || null,
      perWeekLimit: payload.perWeekLimit || null,
      minSubtotal: payload.minSubtotal || null,
      maxSubtotal: payload.maxSubtotal || null,
      minQuantity: payload.minQuantity || null,
      repricingPolicy: payload.repricingPolicy || 'recalculate',
      tags: payload.tags || null,
      status: 'draft',
      createdBy: adminUserId,
      updatedBy: adminUserId,
    }, { transaction: t });

    // Create conditions
    if (Array.isArray(payload.conditions) && payload.conditions.length) {
      for (let i = 0; i < payload.conditions.length; i++) {
        const c = payload.conditions[i];
        await PromotionCondition.create({
          promotionId: promo.id,
          conditionType: c.conditionType,
          operator: c.operator || 'equals',
          value: c.value,
          logicGroup: c.logicGroup || 'ALL',
          sortOrder: c.sortOrder ?? i,
        }, { transaction: t });
      }
    }

    // Create zone overrides
    if (Array.isArray(payload.zoneOverrides) && payload.zoneOverrides.length) {
      for (const zo of payload.zoneOverrides) {
        await PromotionZoneOverride.create({
          promotionId: promo.id,
          zoneId: zo.zoneId,
          discountValue: zo.discountValue ?? null,
          maxDiscountCap: zo.maxDiscountCap ?? null,
          minSubtotal: zo.minSubtotal ?? null,
          currency: zo.currency ?? null,
        }, { transaction: t });
      }
    }

    // Create coupon codes if provided
    if (Array.isArray(payload.couponCodes) && payload.couponCodes.length) {
      for (const cc of payload.couponCodes) {
        await CouponCode.create({
          promotionId: promo.id,
          code: cc.code.toUpperCase().trim(),
          codeType: cc.codeType || 'shared',
          customerId: cc.customerId || null,
          partnerRef: cc.partnerRef || null,
          usageLimit: cc.usageLimit || null,
          perCustomerLimit: cc.perCustomerLimit || null,
          activationDate: cc.activationDate || null,
          expiryDate: cc.expiryDate || null,
          isActive: true,
          createdBy: adminUserId,
        }, { transaction: t });
      }
    }

    await t.commit();
    await audit(promo.id, 'created', adminUserId, { newValue: promo.toJSON() });
    return getPromotionById(promo.id);
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function listPromotions({ page = 1, limit = 50, status, campaignId, benefitType, search } = {}) {
  const where = {};
  if (status) where.status = status;
  if (campaignId) where.campaignId = Number(campaignId);
  if (benefitType) where.benefitType = benefitType;
  if (search) where.name = { [Op.like]: `%${search}%` };

  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
  const { count, rows } = await Promotion.findAndCountAll({
    where,
    order: [['id', 'DESC']],
    limit: Number(limit),
    offset,
    include: [
      { model: CouponCode, as: 'couponCodes', attributes: ['id', 'code', 'usedCount', 'isActive'] },
    ],
  });

  return { count, rows, page: Number(page), limit: Number(limit) };
}

async function getPromotionById(id) {
  const row = await Promotion.findByPk(id, { include: FULL_INCLUDE });
  if (!row) throw new NotFoundError('Promotion not found');
  return row;
}

async function updatePromotion(id, payload, adminUserId) {
  const promo = await Promotion.findByPk(id);
  if (!promo) throw new NotFoundError('Promotion not found');

  // Only drafts can be freely edited
  if (!['draft', 'paused'].includes(promo.status)) {
    throw new ValidationError(`Cannot edit promotion in "${promo.status}" status. Pause it first or create a new version.`);
  }

  const oldValue = promo.toJSON();
  _validate({ ...oldValue, ...payload }, true);

  const t = await sequelize.transaction();
  try {
    await promo.update({
      ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      ...(payload.internalNotes !== undefined ? { internalNotes: payload.internalNotes } : {}),
      ...(payload.benefitType !== undefined ? { benefitType: payload.benefitType } : {}),
      ...(payload.discountValue !== undefined ? { discountValue: payload.discountValue } : {}),
      ...(payload.maxDiscountCap !== undefined ? { maxDiscountCap: payload.maxDiscountCap } : {}),
      ...(payload.currency !== undefined ? { currency: payload.currency } : {}),
      ...(payload.targetType !== undefined ? { targetType: payload.targetType } : {}),
      ...(payload.targetIds !== undefined ? { targetIds: payload.targetIds } : {}),
      ...(payload.zoneScopeMode !== undefined ? { zoneScopeMode: payload.zoneScopeMode } : {}),
      ...(payload.zoneIds !== undefined ? { zoneIds: payload.zoneIds } : {}),
      ...(payload.startDate !== undefined ? { startDate: payload.startDate } : {}),
      ...(payload.endDate !== undefined ? { endDate: payload.endDate } : {}),
      ...(payload.recurringDays !== undefined ? { recurringDays: payload.recurringDays } : {}),
      ...(payload.recurringStartTime !== undefined ? { recurringStartTime: payload.recurringStartTime } : {}),
      ...(payload.recurringEndTime !== undefined ? { recurringEndTime: payload.recurringEndTime } : {}),
      ...(payload.activationType !== undefined ? { activationType: payload.activationType } : {}),
      ...(payload.visibility !== undefined ? { visibility: payload.visibility } : {}),
      ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
      ...(payload.stackable !== undefined ? { stackable: payload.stackable } : {}),
      ...(payload.stackGroup !== undefined ? { stackGroup: payload.stackGroup } : {}),
      ...(payload.globalUsageLimit !== undefined ? { globalUsageLimit: payload.globalUsageLimit } : {}),
      ...(payload.perCustomerLimit !== undefined ? { perCustomerLimit: payload.perCustomerLimit } : {}),
      ...(payload.perDayLimit !== undefined ? { perDayLimit: payload.perDayLimit } : {}),
      ...(payload.perWeekLimit !== undefined ? { perWeekLimit: payload.perWeekLimit } : {}),
      ...(payload.minSubtotal !== undefined ? { minSubtotal: payload.minSubtotal } : {}),
      ...(payload.maxSubtotal !== undefined ? { maxSubtotal: payload.maxSubtotal } : {}),
      ...(payload.minQuantity !== undefined ? { minQuantity: payload.minQuantity } : {}),
      ...(payload.repricingPolicy !== undefined ? { repricingPolicy: payload.repricingPolicy } : {}),
      ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
      updatedBy: adminUserId,
    }, { transaction: t });

    // Replace conditions if provided
    if (Array.isArray(payload.conditions)) {
      await PromotionCondition.destroy({ where: { promotionId: id }, transaction: t });
      for (let i = 0; i < payload.conditions.length; i++) {
        const c = payload.conditions[i];
        await PromotionCondition.create({
          promotionId: id,
          conditionType: c.conditionType,
          operator: c.operator || 'equals',
          value: c.value,
          logicGroup: c.logicGroup || 'ALL',
          sortOrder: c.sortOrder ?? i,
        }, { transaction: t });
      }
    }

    // Replace zone overrides if provided
    if (Array.isArray(payload.zoneOverrides)) {
      await PromotionZoneOverride.destroy({ where: { promotionId: id }, transaction: t });
      for (const zo of payload.zoneOverrides) {
        await PromotionZoneOverride.create({
          promotionId: id,
          zoneId: zo.zoneId,
          discountValue: zo.discountValue ?? null,
          maxDiscountCap: zo.maxDiscountCap ?? null,
          minSubtotal: zo.minSubtotal ?? null,
          currency: zo.currency ?? null,
        }, { transaction: t });
      }
    }

    await t.commit();
    await audit(id, 'updated', adminUserId, { oldValue, newValue: promo.toJSON() });
    return getPromotionById(id);
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// ─── Lifecycle transitions ───────────────────────────────────────────────────

async function changeStatus(id, newStatus, adminUserId, reason) {
  const promo = await Promotion.findByPk(id);
  if (!promo) throw new NotFoundError('Promotion not found');

  const oldStatus = promo.status;
  if (!canTransition(oldStatus, newStatus)) {
    throw new ValidationError(`Cannot transition from "${oldStatus}" to "${newStatus}"`);
  }

  await promo.update({ status: newStatus, updatedBy: adminUserId });
  await audit(id, `status_${newStatus}`, adminUserId, {
    oldValue: { status: oldStatus },
    newValue: { status: newStatus },
    reason,
  });

  return promo.reload();
}

async function publishPromotion(id, adminUserId, reason) {
  const promo = await getPromotionById(id);

  // Can publish from draft, approved, or paused
  if (!['draft', 'approved', 'paused'].includes(promo.status)) {
    throw new ValidationError(`Cannot publish from "${promo.status}" status`);
  }

  const t = await sequelize.transaction();
  try {
    // Get next version number
    const maxVersion = await PromotionVersion.max('versionNumber', {
      where: { promotionId: id },
      transaction: t,
    });
    const nextVersion = (maxVersion || 0) + 1;

    // Create immutable version snapshot
    const configSnapshot = {
      name: promo.name,
      benefitType: promo.benefitType,
      discountValue: promo.discountValue,
      maxDiscountCap: promo.maxDiscountCap,
      currency: promo.currency,
      targetType: promo.targetType,
      targetIds: promo.targetIds,
      zoneScopeMode: promo.zoneScopeMode,
      zoneIds: promo.zoneIds,
      startDate: promo.startDate,
      endDate: promo.endDate,
      recurringDays: promo.recurringDays,
      activationType: promo.activationType,
      visibility: promo.visibility,
      priority: promo.priority,
      stackable: promo.stackable,
      stackGroup: promo.stackGroup,
      globalUsageLimit: promo.globalUsageLimit,
      perCustomerLimit: promo.perCustomerLimit,
      minSubtotal: promo.minSubtotal,
      repricingPolicy: promo.repricingPolicy,
      conditions: (promo.conditions || []).map((c) => ({
        conditionType: c.conditionType,
        operator: c.operator,
        value: c.value,
        logicGroup: c.logicGroup,
      })),
      zoneOverrides: (promo.zoneOverrides || []).map((zo) => ({
        zoneId: zo.zoneId,
        discountValue: zo.discountValue,
        maxDiscountCap: zo.maxDiscountCap,
        minSubtotal: zo.minSubtotal,
        currency: zo.currency,
      })),
    };

    const version = await PromotionVersion.create({
      promotionId: id,
      versionNumber: nextVersion,
      configSnapshot,
      publishedAt: new Date(),
      publishedBy: adminUserId,
      reason: reason || `Published as version ${nextVersion}`,
    }, { transaction: t });

    await promo.update({
      status: 'active',
      currentVersionId: version.id,
      updatedBy: adminUserId,
    }, { transaction: t });

    await t.commit();
    await audit(id, 'published', adminUserId, {
      newValue: { versionNumber: nextVersion, status: 'active' },
      reason,
    });

    return getPromotionById(id);
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function pausePromotion(id, adminUserId, reason) {
  return changeStatus(id, 'paused', adminUserId, reason);
}

async function archivePromotion(id, adminUserId, reason) {
  return changeStatus(id, 'archived', adminUserId, reason);
}

// ─── Coupon code management ─────────────────────────────────────────────────

async function addCouponCode(promotionId, payload, adminUserId) {
  const promo = await Promotion.findByPk(promotionId);
  if (!promo) throw new NotFoundError('Promotion not found');

  if (!payload.code || !payload.code.trim()) {
    throw new ValidationError('Coupon code is required');
  }

  const existing = await CouponCode.findOne({ where: { code: payload.code.toUpperCase().trim() } });
  if (existing) throw new ValidationError(`Coupon code "${payload.code}" already exists`);

  const row = await CouponCode.create({
    promotionId,
    code: payload.code.toUpperCase().trim(),
    codeType: payload.codeType || 'shared',
    customerId: payload.customerId || null,
    partnerRef: payload.partnerRef || null,
    usageLimit: payload.usageLimit || null,
    perCustomerLimit: payload.perCustomerLimit || null,
    activationDate: payload.activationDate || null,
    expiryDate: payload.expiryDate || null,
    isActive: true,
    createdBy: adminUserId,
  });

  await audit(promotionId, 'coupon_added', adminUserId, { newValue: { code: row.code } });
  return row;
}

async function removeCouponCode(couponCodeId, adminUserId) {
  const row = await CouponCode.findByPk(couponCodeId);
  if (!row) throw new NotFoundError('Coupon code not found');

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

async function clonePromotion(id, adminUserId) {
  const source = await getPromotionById(id);
  const payload = {
    ...source.toJSON(),
    name: `${source.name} (Copy)`,
    status: 'draft',
    globalUsedCount: 0,
    globalReservedCount: 0,
    currentVersionId: null,
    conditions: (source.conditions || []).map((c) => ({
      conditionType: c.conditionType,
      operator: c.operator,
      value: c.value,
      logicGroup: c.logicGroup,
      sortOrder: c.sortOrder,
    })),
    zoneOverrides: (source.zoneOverrides || []).map((zo) => ({
      zoneId: zo.zoneId,
      discountValue: zo.discountValue,
      maxDiscountCap: zo.maxDiscountCap,
      minSubtotal: zo.minSubtotal,
      currency: zo.currency,
    })),
    couponCodes: [],
  };
  delete payload.id;
  delete payload.createdAt;
  delete payload.updatedAt;
  delete payload.versions;
  delete payload.redemptions;

  return createPromotion(payload, adminUserId);
}

// ─── Analytics (basic) ──────────────────────────────────────────────────────

async function getPromotionAnalytics(id) {
  const { promotionRedemption: Redemption } = require('../../models');
  const promo = await Promotion.findByPk(id);
  if (!promo) throw new NotFoundError('Promotion not found');

  const [committed, reserved, reversed] = await Promise.all([
    Redemption.count({ where: { promotionId: id, status: 'COMMITTED' } }),
    Redemption.count({ where: { promotionId: id, status: 'RESERVED' } }),
    Redemption.count({ where: { promotionId: id, status: 'REVERSED' } }),
  ]);

  const totalDiscount = await Redemption.sum('discountAmount', {
    where: { promotionId: id, status: 'COMMITTED' },
  });

  const uniqueCustomers = await Redemption.count({
    where: { promotionId: id, status: 'COMMITTED' },
    distinct: true,
    col: 'customerId',
  });

  return {
    promotionId: id,
    name: promo.name,
    status: promo.status,
    redemptions: { committed, reserved, reversed },
    totalDiscount: parseFloat(totalDiscount || 0).toFixed(2),
    uniqueCustomers,
    globalUsedCount: promo.globalUsedCount,
    globalUsageLimit: promo.globalUsageLimit,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const VALID_BENEFIT_TYPES = [
  'percentage_discount', 'fixed_amount_discount', 'fixed_price', 'free_delivery',
  'delivery_discount', 'item_discount', 'category_discount', 'service_discount',
  'basket_discount', 'cashback', 'buy_x_get_y', 'bundle',
  'first_order_discount', 'first_x_orders_discount',
];

function _validate(p, isUpdate = false) {
  if (!isUpdate && (!p.name || !String(p.name).trim())) {
    throw new ValidationError('Promotion name is required');
  }
  if (p.benefitType && !VALID_BENEFIT_TYPES.includes(p.benefitType)) {
    throw new ValidationError(`Invalid benefitType: ${p.benefitType}`);
  }
  if (p.discountValue != null) {
    const val = parseFloat(p.discountValue);
    if (!Number.isFinite(val) || val < 0) {
      throw new ValidationError('discountValue must be a non-negative number');
    }
    if (p.benefitType && p.benefitType.includes('percentage') && val > 100) {
      throw new ValidationError('Percentage discount cannot exceed 100%');
    }
  }
  if (p.zoneScopeMode && !['all', 'selected', 'excluded'].includes(p.zoneScopeMode)) {
    throw new ValidationError('Invalid zoneScopeMode');
  }
  if (p.zoneScopeMode && p.zoneScopeMode !== 'all') {
    if (!Array.isArray(p.zoneIds) || !p.zoneIds.length) {
      throw new ValidationError('zoneIds required for selected/excluded zone scope');
    }
  }
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
};

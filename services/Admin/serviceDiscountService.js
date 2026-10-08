'use strict';

const { Op } = require('sequelize');
const {
  serviceDiscount,
  subCategories,
  addOnServices,
  categories,
} = require('../../models');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');
const { isPromotionsCheckoutEnabled } = require('../promotions/checkoutFlag');

/** Apply decimal math safely */
function money(val) {
  if (val == null) return '0.00';
  return Number(parseFloat(val).toFixed(2)).toFixed(2);
}

function normalizeTargetIds(payload = {}) {
  if ((payload.targetType || 'all') === 'all') return [];
  let raw = [];
  if (Array.isArray(payload.targetIds) && payload.targetIds.length) {
    raw = payload.targetIds;
  } else if (payload.targetId != null && payload.targetId !== '') {
    raw = [payload.targetId];
  }
  return [
    ...new Set(
      raw
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
}

function targetIdsOf(row) {
  const fromJson = Array.isArray(row.targetIds) ? row.targetIds : null;
  if (fromJson && fromJson.length) {
    return fromJson.map(Number).filter((id) => Number.isFinite(id) && id > 0);
  }
  if (row.targetId != null && Number(row.targetId) > 0) {
    return [Number(row.targetId)];
  }
  return [];
}

function matchesTarget(row, selector = {}) {
  if (row.targetType === 'all') return true;
  const ids = targetIdsOf(row);
  if (!ids.length) return false;

  if (row.targetType === 'service') {
    return selector.serviceId != null && ids.includes(Number(selector.serviceId));
  }
  if (row.targetType === 'category') {
    return selector.categoryId != null && ids.includes(Number(selector.categoryId));
  }
  if (row.targetType === 'subCategory') {
    return selector.subCategoryId != null && ids.includes(Number(selector.subCategoryId));
  }
  if (row.targetType === 'addon') {
    return selector.addOnServiceId != null && ids.includes(Number(selector.addOnServiceId));
  }
  return false;
}

/** Load currently active (date-valid) discount rules once for catalog decoration. */
async function loadActiveDiscountRules() {
  const now = new Date();
  return serviceDiscount.findAll({
    where: {
      isActive: true,
      [Op.and]: [
        {
          [Op.or]: [{ validFrom: null }, { validFrom: { [Op.lte]: now } }],
        },
        {
          [Op.or]: [{ validTo: null }, { validTo: { [Op.gte]: now } }],
        },
      ],
    },
  });
}

function ruleMatchesZone(row, zoneId) {
  if (row.zoneMode !== 'specific') return true;
  const ids = Array.isArray(row.zoneIds) ? row.zoneIds : [];
  if (!ids.length) return false;
  const zid = Number(zoneId);
  if (!Number.isFinite(zid)) return false;
  return ids.map(Number).includes(zid);
}

/**
 * Find all active discounts that match a given (zoneId, selector) context.
 * selector: { subCategoryId?, addOnServiceId?, serviceId?, categoryId? }
 */
async function findApplicableDiscounts(zoneId, selector = {}) {
  const rows = await loadActiveDiscountRules();
  return rows.filter(
    (d) => ruleMatchesZone(d, zoneId) && matchesTarget(d, selector)
  );
}

/**
 * Sync best-discount picker against a preloaded rules list (no DB).
 */
function pickBestDiscountFromRules(rules, zoneId, selector, basePrice) {
  // Legacy is switched off where Promotions run at checkout (docs/PROMOTIONS_CHECKOUT_PLAN.md,
  // Phase 6): catalog prices stay full and the promotions engine discounts on the invoice.
  if (isPromotionsCheckoutEnabled(zoneId)) {
    return { discountedPrice: money(basePrice), appliedDiscount: null };
  }
  const applicable = (rules || []).filter(
    (d) => ruleMatchesZone(d, zoneId) && matchesTarget(d, selector)
  );
  if (!applicable.length) {
    return { discountedPrice: money(basePrice), appliedDiscount: null };
  }

  const base = parseFloat(basePrice) || 0;
  let best = null;
  let bestSaving = -1;
  for (const d of applicable) {
    const val = parseFloat(d.discountValue) || 0;
    let saving;
    if (d.discountType === 'percentage') {
      let s = (base * val) / 100;
      if (d.maxDiscountCap != null && d.maxDiscountCap !== '') {
        s = Math.min(s, parseFloat(d.maxDiscountCap));
      }
      saving = s;
    } else {
      saving = Math.min(val, base);
    }
    if (saving > bestSaving) {
      bestSaving = saving;
      best = d;
    }
  }

  if (!best || bestSaving <= 0) {
    return { discountedPrice: money(basePrice), appliedDiscount: null };
  }

  const finalPrice = Math.max(0, base - bestSaving);
  const discountType = best.discountType;
  const discountValue = parseFloat(best.discountValue);
  return {
    discountedPrice: money(finalPrice),
    originalPrice: money(base),
    saving: money(bestSaving),
    appliedDiscount: {
      id: best.id,
      name: best.name,
      discountType,
      discountValue,
      maxDiscountCap: best.maxDiscountCap ? parseFloat(best.maxDiscountCap) : null,
      label:
        discountType === 'percentage'
          ? `${discountValue}% OFF`
          : `£${Number(discountValue).toFixed(2)} OFF`,
    },
  };
}

/**
 * Apply the best (highest-value) matching discount to a price.
 */
async function applyBestDiscount(zoneId, selector, basePrice) {
  const rules = await loadActiveDiscountRules();
  return pickBestDiscountFromRules(rules, zoneId, selector, basePrice);
}

/**
 * Decorate a priced catalog row with discount fields for agent/customer UI.
 * `price` becomes the discounted amount when a rule applies.
 */
function decoratePriceWithDiscount(row, rules, zoneId, selector) {
  const base = parseFloat(row.price) || 0;
  const result = pickBestDiscountFromRules(rules, zoneId, selector, base);
  if (!result.appliedDiscount) {
    return {
      ...row,
      price: money(base),
      originalPrice: null,
      saving: null,
      hasDiscount: false,
      appliedDiscount: null,
    };
  }
  return {
    ...row,
    price: result.discountedPrice,
    originalPrice: result.originalPrice,
    saving: result.saving,
    hasDiscount: true,
    appliedDiscount: result.appliedDiscount,
  };
}

// ─── Price guards for flat discounts ─────────────────────────────────────────

/**
 * Resolve priced leaf items for the selected targets.
 * Returns [{ id, name, price, kind }]
 */
async function resolvePricedItems(targetType, targetIds) {
  const ids = (targetIds || []).map(Number).filter((id) => id > 0);
  if (!ids.length && targetType !== 'all') return [];

  if (targetType === 'addon') {
    const rows = await addOnServices.findAll({
      where: { id: { [Op.in]: ids } },
      attributes: ['id', 'name', 'price'],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      price: parseFloat(r.price) || 0,
      kind: 'addon',
    }));
  }

  if (targetType === 'subCategory') {
    const rows = await subCategories.findAll({
      where: { id: { [Op.in]: ids } },
      attributes: ['id', 'name', 'price'],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      price: parseFloat(r.price) || 0,
      kind: 'item',
    }));
  }

  if (targetType === 'category') {
    const rows = await subCategories.findAll({
      where: { categoryId: { [Op.in]: ids }, status: true },
      attributes: ['id', 'name', 'price', 'categoryId'],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      price: parseFloat(r.price) || 0,
      kind: 'item',
      parentId: r.categoryId,
    }));
  }

  if (targetType === 'service') {
    const cats = await categories.findAll({
      where: { serviceId: { [Op.in]: ids } },
      attributes: ['id', 'serviceId'],
    });
    const catIds = cats.map((c) => c.id);
    if (!catIds.length) return [];
    const rows = await subCategories.findAll({
      where: { categoryId: { [Op.in]: catIds }, status: true },
      attributes: ['id', 'name', 'price', 'categoryId'],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      price: parseFloat(r.price) || 0,
      kind: 'item',
    }));
  }

  if (targetType === 'all') {
    const [items, addons] = await Promise.all([
      subCategories.findAll({
        where: { status: true },
        attributes: ['id', 'name', 'price'],
        limit: 5000,
      }),
      addOnServices.findAll({
        where: { status: true },
        attributes: ['id', 'name', 'price'],
        limit: 5000,
      }),
    ]);
    return [
      ...items.map((r) => ({
        id: r.id,
        name: r.name,
        price: parseFloat(r.price) || 0,
        kind: 'item',
      })),
      ...addons.map((r) => ({
        id: r.id,
        name: r.name,
        price: parseFloat(r.price) || 0,
        kind: 'addon',
      })),
    ].filter((r) => r.price > 0);
  }

  return [];
}

async function assertFlatWithinCatalogPrices(targetType, targetIds, discountValue) {
  const amount = parseFloat(discountValue);
  if (!Number.isFinite(amount) || amount <= 0) return;

  const priced = await resolvePricedItems(targetType, targetIds);
  if (!priced.length) {
    if (targetType === 'service' || targetType === 'category') {
      throw new ValidationError(
        `No priced items found under the selected ${targetType === 'service' ? 'service(s)' : 'categor(y/ies)'}. ` +
          'Add catalog prices first, or use a percentage discount.'
      );
    }
    if (targetType === 'subCategory' || targetType === 'addon') {
      throw new ValidationError('Selected target(s) were not found or have no price in the database.');
    }
    throw new ValidationError(
      'Cannot validate a flat discount against an empty catalog. Use a percentage discount instead.'
    );
  }

  const cheapest = priced.reduce((a, b) => (a.price <= b.price ? a : b));
  if (amount > cheapest.price) {
    const kindLabel = cheapest.kind === 'addon' ? 'add-on' : 'item';
    throw new ValidationError(
      `Flat discount £${amount.toFixed(2)} exceeds the price of ${kindLabel} "${cheapest.name}" ` +
        `(£${cheapest.price.toFixed(2)}). Lower the discount to £${cheapest.price.toFixed(2)} or below, ` +
        'remove that target, or switch to a percentage discount.'
    );
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

async function createDiscount(payload, adminUserId) {
  await _validateAsync(payload);
  const targetIds = normalizeTargetIds(payload);
  const targetId = targetIds.length === 1 ? targetIds[0] : targetIds[0] ?? null;

  return serviceDiscount.create({
    name: payload.name.trim(),
    discountType: payload.discountType,
    discountValue: payload.discountValue,
    maxDiscountCap: payload.maxDiscountCap ?? null,
    targetType: payload.targetType || 'all',
    targetId: (payload.targetType || 'all') === 'all' ? null : targetId,
    targetIds: (payload.targetType || 'all') === 'all' ? null : targetIds,
    zoneMode: payload.zoneMode || 'all',
    zoneIds: payload.zoneIds ?? null,
    validFrom: payload.validFrom ?? null,
    validTo: payload.validTo ?? null,
    isActive: payload.isActive !== false,
    createdBy: adminUserId ?? null,
  });
}

async function listDiscounts({ page = 1, limit = 50, isActive } = {}) {
  const where = {};
  if (isActive !== undefined) where.isActive = isActive === true || isActive === 'true';
  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
  const { count, rows } = await serviceDiscount.findAndCountAll({
    where,
    order: [['id', 'DESC']],
    limit: Number(limit),
    offset,
  });
  return { count, rows, page: Number(page), limit: Number(limit) };
}

async function getDiscountById(id) {
  const row = await serviceDiscount.findByPk(id);
  if (!row) throw new NotFoundError('Service discount not found');
  return row;
}

async function updateDiscount(id, payload) {
  const row = await getDiscountById(id);
  const merged = { ...row.toJSON(), ...payload };
  if (payload.targetIds !== undefined || payload.targetId !== undefined) {
    merged.targetIds = normalizeTargetIds({
      targetType: payload.targetType ?? row.targetType,
      targetIds: payload.targetIds !== undefined ? payload.targetIds : row.targetIds,
      targetId: payload.targetId !== undefined ? payload.targetId : row.targetId,
    });
  }
  await _validateAsync(merged);

  const targetType = payload.targetType !== undefined ? payload.targetType : row.targetType;
  let nextTargetIds;
  let nextTargetId;
  if (
    payload.targetIds !== undefined ||
    payload.targetId !== undefined ||
    payload.targetType !== undefined
  ) {
    nextTargetIds = normalizeTargetIds({
      targetType,
      targetIds: payload.targetIds !== undefined ? payload.targetIds : row.targetIds,
      targetId: payload.targetId !== undefined ? payload.targetId : row.targetId,
    });
    nextTargetId = targetType === 'all' ? null : nextTargetIds[0] ?? null;
    if (targetType === 'all') nextTargetIds = null;
  }

  await row.update({
    ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
    ...(payload.discountType !== undefined ? { discountType: payload.discountType } : {}),
    ...(payload.discountValue !== undefined ? { discountValue: payload.discountValue } : {}),
    ...(payload.maxDiscountCap !== undefined ? { maxDiscountCap: payload.maxDiscountCap ?? null } : {}),
    ...(payload.targetType !== undefined ? { targetType: payload.targetType } : {}),
    ...(nextTargetIds !== undefined ? { targetIds: nextTargetIds, targetId: nextTargetId } : {}),
    ...(payload.zoneMode !== undefined ? { zoneMode: payload.zoneMode } : {}),
    ...(payload.zoneIds !== undefined ? { zoneIds: payload.zoneIds ?? null } : {}),
    ...(payload.validFrom !== undefined ? { validFrom: payload.validFrom ?? null } : {}),
    ...(payload.validTo !== undefined ? { validTo: payload.validTo ?? null } : {}),
    ...(payload.isActive !== undefined ? { isActive: Boolean(payload.isActive) } : {}),
  });
  return row.reload();
}

async function deleteDiscount(id) {
  const row = await getDiscountById(id);
  await row.destroy();
  return { deleted: true };
}

async function resolveTargetLabel(row) {
  const ids = targetIdsOf(row);
  if (!ids.length || row.targetType === 'all') return null;
  try {
    if (row.targetType === 'subCategory') {
      const items = await subCategories.findAll({
        where: { id: { [Op.in]: ids } },
        attributes: ['id', 'name'],
      });
      return items.map((i) => ({ id: i.id, name: i.name }));
    }
    if (row.targetType === 'addon') {
      const items = await addOnServices.findAll({
        where: { id: { [Op.in]: ids } },
        attributes: ['id', 'name'],
      });
      return items.map((i) => ({ id: i.id, name: i.name }));
    }
    if (row.targetType === 'category') {
      const items = await categories.findAll({
        where: { id: { [Op.in]: ids } },
        attributes: ['id', 'name'],
      });
      return items.map((i) => ({ id: i.id, name: i.name }));
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

async function _validateAsync(p) {
  if (!p.name || !String(p.name).trim()) throw new ValidationError('name is required');
  if (!['percentage', 'flat'].includes(p.discountType)) {
    throw new ValidationError('discountType must be percentage or flat');
  }
  const val = parseFloat(p.discountValue);
  if (!Number.isFinite(val) || val <= 0) {
    throw new ValidationError('discountValue must be a positive number');
  }
  if (p.discountType === 'percentage' && val > 100) {
    throw new ValidationError('Percentage discount cannot exceed 100%');
  }
  if (p.discountType === 'percentage' && p.maxDiscountCap != null && p.maxDiscountCap !== '') {
    const cap = parseFloat(p.maxDiscountCap);
    if (!Number.isFinite(cap) || cap < 0) {
      throw new ValidationError('maxDiscountCap must be a non-negative number');
    }
  }

  const targetType = p.targetType || 'all';
  if (!['all', 'service', 'category', 'subCategory', 'addon'].includes(targetType)) {
    throw new ValidationError('Invalid targetType');
  }

  const targetIds = normalizeTargetIds(p);
  if (targetType !== 'all' && !targetIds.length) {
    throw new ValidationError('Select at least one target (service, category, item, or add-on)');
  }

  if (!['all', 'specific'].includes(p.zoneMode || 'all')) {
    throw new ValidationError('Invalid zoneMode');
  }
  if ((p.zoneMode || 'all') === 'specific') {
    if (!Array.isArray(p.zoneIds) || !p.zoneIds.length) {
      throw new ValidationError('zoneIds array is required when zoneMode=specific');
    }
  }

  if (p.discountType === 'flat') {
    await assertFlatWithinCatalogPrices(targetType, targetIds, val);
  }
}

module.exports = {
  createDiscount,
  listDiscounts,
  getDiscountById,
  updateDiscount,
  deleteDiscount,
  applyBestDiscount,
  findApplicableDiscounts,
  loadActiveDiscountRules,
  pickBestDiscountFromRules,
  decoratePriceWithDiscount,
  resolveTargetLabel,
  normalizeTargetIds,
  resolvePricedItems,
};

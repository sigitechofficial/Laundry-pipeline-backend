'use strict';

const { Op } = require('sequelize');
const { serviceDiscount, subCategories, addOnServices } = require('../../models');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');

/** Apply decimal math safely */
function money(val) {
  if (val == null) return '0.00';
  return Number(parseFloat(val).toFixed(2)).toFixed(2);
}

/**
 * Find all active discounts that match a given (zoneId, selector) context.
 * selector: { subCategoryId?, addOnServiceId?, serviceId?, categoryId? }
 *
 * Matching logic (any of these conditions wins):
 *  targetType='all'         → always matches
 *  targetType='service'     → targetId matches selector.serviceId
 *  targetType='category'    → targetId matches selector.categoryId
 *  targetType='subCategory' → targetId matches selector.subCategoryId
 *  targetType='addon'       → targetId matches selector.addOnServiceId
 *
 * Zone filter:
 *  zoneMode='all'      → always matches
 *  zoneMode='specific' → zoneId must be in zoneIds array
 */
async function findApplicableDiscounts(zoneId, selector = {}) {
  const now = new Date();

  const rows = await serviceDiscount.findAll({
    where: {
      isActive: true,
      [Op.and]: [
        // validFrom: null or past
        {
          [Op.or]: [
            { validFrom: null },
            { validFrom: { [Op.lte]: now } },
          ],
        },
        // validTo: null or future
        {
          [Op.or]: [
            { validTo: null },
            { validTo: { [Op.gte]: now } },
          ],
        },
      ],
    },
  });

  return rows.filter((d) => {
    // --- Zone check ---
    if (d.zoneMode === 'specific') {
      const ids = Array.isArray(d.zoneIds) ? d.zoneIds : [];
      if (!ids.length) return false;
      const zid = Number(zoneId);
      if (!ids.map(Number).includes(zid)) return false;
    }

    // --- Target check ---
    if (d.targetType === 'all') return true;

    if (d.targetType === 'service') {
      return selector.serviceId != null && Number(d.targetId) === Number(selector.serviceId);
    }
    if (d.targetType === 'category') {
      return selector.categoryId != null && Number(d.targetId) === Number(selector.categoryId);
    }
    if (d.targetType === 'subCategory') {
      return selector.subCategoryId != null && Number(d.targetId) === Number(selector.subCategoryId);
    }
    if (d.targetType === 'addon') {
      return selector.addOnServiceId != null && Number(d.targetId) === Number(selector.addOnServiceId);
    }

    return false;
  });
}

/**
 * Apply the best (highest-value) matching discount to a price.
 * Returns { discountedPrice, appliedDiscount } where appliedDiscount may be null.
 */
async function applyBestDiscount(zoneId, selector, basePrice) {
  const applicable = await findApplicableDiscounts(zoneId, selector);
  if (!applicable.length) {
    return { discountedPrice: money(basePrice), appliedDiscount: null };
  }

  const base = parseFloat(basePrice) || 0;

  // Pick discount that gives the largest absolute saving
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
      saving = Math.min(val, base); // flat discount capped at base price
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
  return {
    discountedPrice: money(finalPrice),
    originalPrice: money(base),
    saving: money(bestSaving),
    appliedDiscount: {
      id: best.id,
      name: best.name,
      discountType: best.discountType,
      discountValue: parseFloat(best.discountValue),
      maxDiscountCap: best.maxDiscountCap ? parseFloat(best.maxDiscountCap) : null,
    },
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

async function createDiscount(payload, adminUserId) {
  _validate(payload);
  return serviceDiscount.create({
    name: payload.name.trim(),
    discountType: payload.discountType,
    discountValue: payload.discountValue,
    maxDiscountCap: payload.maxDiscountCap ?? null,
    targetType: payload.targetType || 'all',
    targetId: payload.targetId ?? null,
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

async function updateDiscount(id, payload, adminUserId) {
  const row = await getDiscountById(id);
  _validate({ ...row.toJSON(), ...payload });
  await row.update({
    ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
    ...(payload.discountType !== undefined ? { discountType: payload.discountType } : {}),
    ...(payload.discountValue !== undefined ? { discountValue: payload.discountValue } : {}),
    ...(payload.maxDiscountCap !== undefined ? { maxDiscountCap: payload.maxDiscountCap ?? null } : {}),
    ...(payload.targetType !== undefined ? { targetType: payload.targetType } : {}),
    ...(payload.targetId !== undefined ? { targetId: payload.targetId ?? null } : {}),
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

// Resolve target label for API responses
async function resolveTargetLabel(row) {
  if (!row.targetId || row.targetType === 'all') return null;
  try {
    if (row.targetType === 'subCategory') {
      const item = await subCategories.findByPk(row.targetId, { attributes: ['id', 'name'] });
      return item ? { id: item.id, name: item.name } : null;
    }
    if (row.targetType === 'addon') {
      const item = await addOnServices.findByPk(row.targetId, { attributes: ['id', 'name'] });
      return item ? { id: item.id, name: item.name } : null;
    }
    // service and category resolved by the admin panel lookup
    return null;
  } catch {
    return null;
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

function _validate(p) {
  if (!p.name || !String(p.name).trim()) throw new ValidationError('name is required');
  if (!['percentage', 'flat'].includes(p.discountType)) throw new ValidationError('discountType must be percentage or flat');
  const val = parseFloat(p.discountValue);
  if (!Number.isFinite(val) || val <= 0) throw new ValidationError('discountValue must be a positive number');
  if (p.discountType === 'percentage' && val > 100) throw new ValidationError('percentage discountValue cannot exceed 100');
  if (!['all', 'service', 'category', 'subCategory', 'addon'].includes(p.targetType || 'all')) {
    throw new ValidationError('Invalid targetType');
  }
  if ((p.targetType || 'all') !== 'all' && !p.targetId) {
    throw new ValidationError('targetId is required when targetType is not "all"');
  }
  if (!['all', 'specific'].includes(p.zoneMode || 'all')) throw new ValidationError('Invalid zoneMode');
  if ((p.zoneMode || 'all') === 'specific') {
    if (!Array.isArray(p.zoneIds) || !p.zoneIds.length) {
      throw new ValidationError('zoneIds array is required when zoneMode=specific');
    }
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
  resolveTargetLabel,
};

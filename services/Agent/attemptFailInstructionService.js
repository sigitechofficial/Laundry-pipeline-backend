'use strict';

const { Op } = require('sequelize');
const {
  attemptFailInstructionSet,
  attemptFailInstruction,
  booking,
} = require('../../models');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');

function normalizeScope(scope) {
  const s = String(scope || '').trim().toLowerCase();
  if (s === 'pickup' || s === 'delivery') return s;
  throw new ValidationError('scope must be pickup or delivery');
}

/**
 * Resolve active set for scope: zone-specific first, else global (zoneId null).
 */
async function resolveActiveSet(scope, zoneId = null) {
  const normalized = normalizeScope(scope);
  if (zoneId != null) {
    const zoneSet = await attemptFailInstructionSet.findOne({
      where: {
        scope: normalized,
        zoneId: Number(zoneId),
        isActive: true,
      },
      order: [['id', 'DESC']],
    });
    if (zoneSet) return zoneSet;
  }
  return attemptFailInstructionSet.findOne({
    where: {
      scope: normalized,
      zoneId: null,
      isActive: true,
    },
    order: [['id', 'DESC']],
  });
}

async function getFailComplianceForAgent({ scope, bookingId = null, zoneId = null }) {
  let resolvedZoneId = zoneId;
  if (resolvedZoneId == null && bookingId != null) {
    const row = await booking.findByPk(bookingId, {
      attributes: ['id', 'zoneId'],
    });
    resolvedZoneId = row?.zoneId ?? null;
  }

  const set = await resolveActiveSet(scope, resolvedZoneId);
  if (!set) {
    return {
      setId: null,
      version: null,
      requireAck: false,
      items: [],
    };
  }

  const items = await attemptFailInstruction.findAll({
    where: { setId: set.id, isEnabled: true },
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  const mapped = items.map((item) => ({
    id: item.id,
    title: item.title,
    body: item.body || null,
    required: Boolean(item.isRequired),
  }));

  return {
    setId: set.id,
    version: set.version,
    requireAck: mapped.some((i) => i.required),
    items: mapped,
  };
}

/**
 * Validate agent compliance payload against current enabled required items.
 * Returns snapshot for audit. Throws ValidationError on mismatch.
 */
async function validateFailComplianceAck({
  scope,
  compliance,
  bookingId = null,
  zoneId = null,
}) {
  const payload = compliance && typeof compliance === 'object' ? compliance : {};
  const catalog = await getFailComplianceForAgent({ scope, bookingId, zoneId });
  const requiredIds = catalog.items.filter((i) => i.required).map((i) => i.id);

  if (!catalog.setId || requiredIds.length === 0) {
    return {
      setId: catalog.setId,
      version: catalog.version,
      snapshot: catalog.items,
    };
  }

  const setId = Number(payload.setId);
  const version = Number(payload.version);
  const acknowledged = Array.isArray(payload.acknowledgedItemIds)
    ? payload.acknowledgedItemIds.map((id) => Number(id)).filter(Number.isFinite)
    : [];

  if (!Number.isFinite(setId) || setId !== catalog.setId) {
    throw new ValidationError('Fail compliance set is outdated. Refresh and try again.', {
      code: 'FAIL_COMPLIANCE_SET_MISMATCH',
    });
  }
  if (!Number.isFinite(version) || version !== catalog.version) {
    throw new ValidationError('Fail compliance checklist was updated. Refresh and try again.', {
      code: 'FAIL_COMPLIANCE_VERSION_MISMATCH',
    });
  }

  const missing = requiredIds.filter((id) => !acknowledged.includes(id));
  if (missing.length) {
    throw new ValidationError(
      'Acknowledge all required steps before marking this attempt failed.',
      {
        code: 'FAIL_COMPLIANCE_REQUIRED',
        missingItemIds: missing,
      }
    );
  }

  const ackSet = new Set(acknowledged);
  const snapshot = catalog.items
    .filter((i) => ackSet.has(i.id) || i.required)
    .map((i) => ({
      id: i.id,
      title: i.title,
      body: i.body,
      required: i.required,
      acknowledged: ackSet.has(i.id),
    }));

  return {
    setId: catalog.setId,
    version: catalog.version,
    snapshot,
  };
}

async function listSetsAdmin({ scope } = {}) {
  const where = {};
  if (scope) where.scope = normalizeScope(scope);
  const sets = await attemptFailInstructionSet.findAll({
    where,
    include: [
      {
        model: attemptFailInstruction,
        as: 'items',
        required: false,
      },
    ],
    order: [
      ['scope', 'ASC'],
      ['zoneId', 'ASC'],
      ['id', 'ASC'],
      [{ model: attemptFailInstruction, as: 'items' }, 'sortOrder', 'ASC'],
    ],
  });
  return sets;
}

async function getSetByIdAdmin(setId) {
  const set = await attemptFailInstructionSet.findByPk(setId, {
    include: [{ model: attemptFailInstruction, as: 'items' }],
    order: [[{ model: attemptFailInstruction, as: 'items' }, 'sortOrder', 'ASC']],
  });
  if (!set) throw new NotFoundError('Fail instruction set not found');
  return set;
}

async function bumpSetVersion(setId, transaction) {
  const set = await attemptFailInstructionSet.findByPk(setId, { transaction });
  if (!set) throw new NotFoundError('Fail instruction set not found');
  await set.update({ version: Number(set.version || 1) + 1 }, { transaction });
  return set;
}

async function createInstruction({ setId, title, body, sortOrder, isEnabled, isRequired }) {
  const set = await attemptFailInstructionSet.findByPk(setId);
  if (!set) throw new NotFoundError('Fail instruction set not found');
  const titleTrim = String(title || '').trim();
  if (!titleTrim) throw new ValidationError('title is required');

  const maxSort =
    (await attemptFailInstruction.max('sortOrder', { where: { setId } })) || 0;

  const item = await attemptFailInstruction.create({
    setId,
    title: titleTrim.slice(0, 255),
    body: body != null ? String(body).slice(0, 1000) : null,
    sortOrder: sortOrder != null ? Number(sortOrder) : Number(maxSort) + 1,
    isEnabled: isEnabled !== false,
    isRequired: isRequired !== false,
  });
  await bumpSetVersion(setId);
  return item;
}

async function updateInstruction(id, patch = {}) {
  const item = await attemptFailInstruction.findByPk(id);
  if (!item) throw new NotFoundError('Fail instruction not found');

  const next = {};
  if (patch.title != null) {
    const t = String(patch.title).trim();
    if (!t) throw new ValidationError('title is required');
    next.title = t.slice(0, 255);
  }
  if (patch.body !== undefined) {
    next.body = patch.body == null ? null : String(patch.body).slice(0, 1000);
  }
  if (patch.sortOrder != null) next.sortOrder = Number(patch.sortOrder);
  if (patch.isEnabled != null) next.isEnabled = Boolean(patch.isEnabled);
  if (patch.isRequired != null) next.isRequired = Boolean(patch.isRequired);
  if (next.isEnabled === false) next.isRequired = false;

  await item.update(next);
  await bumpSetVersion(item.setId);
  return attemptFailInstruction.findByPk(id);
}

async function reorderInstructions(setId, orderedIds = []) {
  const set = await attemptFailInstructionSet.findByPk(setId);
  if (!set) throw new NotFoundError('Fail instruction set not found');
  const ids = orderedIds.map((id) => Number(id)).filter(Number.isFinite);
  const items = await attemptFailInstruction.findAll({ where: { setId } });
  const byId = new Map(items.map((i) => [i.id, i]));
  let order = 1;
  for (const id of ids) {
    const item = byId.get(id);
    if (item) {
      await item.update({ sortOrder: order });
      order += 1;
    }
  }
  await bumpSetVersion(setId);
  return getSetByIdAdmin(setId);
}

async function createOrActivateZoneSet({ scope, zoneId, name }) {
  const normalized = normalizeScope(scope);
  if (zoneId == null) throw new ValidationError('zoneId is required for zone sets');
  const existing = await attemptFailInstructionSet.findOne({
    where: { scope: normalized, zoneId: Number(zoneId) },
  });
  if (existing) {
    await existing.update({ isActive: true });
    return getSetByIdAdmin(existing.id);
  }

  const global = await resolveActiveSet(normalized, null);
  const set = await attemptFailInstructionSet.create({
    scope: normalized,
    name: name || `Zone ${zoneId} ${normalized} fail checklist`,
    zoneId: Number(zoneId),
    isActive: true,
    version: 1,
  });

  if (global) {
    const globals = await attemptFailInstruction.findAll({
      where: { setId: global.id },
      order: [['sortOrder', 'ASC']],
    });
    for (const g of globals) {
      await attemptFailInstruction.create({
        setId: set.id,
        title: g.title,
        body: g.body,
        sortOrder: g.sortOrder,
        isEnabled: g.isEnabled,
        isRequired: g.isRequired,
      });
    }
  }

  return getSetByIdAdmin(set.id);
}

async function setSetActive(setId, isActive) {
  const set = await attemptFailInstructionSet.findByPk(setId);
  if (!set) throw new NotFoundError('Fail instruction set not found');
  if (set.zoneId == null && isActive === false) {
    throw new ValidationError('Global fail instruction sets cannot be deactivated');
  }
  await set.update({ isActive: Boolean(isActive) });
  return getSetByIdAdmin(setId);
}

module.exports = {
  normalizeScope,
  resolveActiveSet,
  getFailComplianceForAgent,
  validateFailComplianceAck,
  listSetsAdmin,
  getSetByIdAdmin,
  createInstruction,
  updateInstruction,
  reorderInstructions,
  createOrActivateZoneSet,
  setSetActive,
};

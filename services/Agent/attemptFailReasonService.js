'use strict';

const { attemptFailReason } = require('../../models');
const { ValidationError } = require('../../middlewares/universalErrorHandler');
const {
  DEFAULT_ATTEMPT_FAIL_REASONS,
  normalizeScope,
  scopeMatches,
  slugifyCode,
} = require('./attemptFailReasonCatalog');

function toPublic(row, extras = {}) {
  const plain = row.get ? row.get({ plain: true }) : row;
  return {
    id: Number(plain.id),
    code: plain.code,
    label: plain.label,
    description: plain.description || null,
    scope: plain.scope,
    chargesFee: Boolean(plain.chargesFee),
    requiresNote: Boolean(plain.requiresNote),
    isOther: Boolean(plain.isOther),
    sortOrder: Number(plain.sortOrder || 0),
    status: plain.status !== false,
    ...extras,
  };
}

async function ensureDefaultReasons() {
  const count = await attemptFailReason.count();
  if (count > 0) return count;

  const now = new Date();
  await attemptFailReason.bulkCreate(
    DEFAULT_ATTEMPT_FAIL_REASONS.map((r) => ({
      ...r,
      status: true,
      createdAt: now,
      updatedAt: now,
    })),
    { ignoreDuplicates: true }
  );
  return attemptFailReason.count();
}

async function listEnabledForAttemptType(attemptType) {
  await ensureDefaultReasons();
  const rows = await attemptFailReason.findAll({
    where: { status: true },
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return rows.filter((r) => scopeMatches(r.scope, attemptType)).map((r) => toPublic(r));
}

async function listAdmin({ scope } = {}) {
  await ensureDefaultReasons();
  const rows = await attemptFailReason.findAll({
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const wanted = normalizeScope(scope);
  const filtered = wanted
    ? rows.filter((r) => scopeMatches(r.scope, wanted) || r.scope === wanted)
    : rows;
  return filtered.map((r) => toPublic(r));
}

async function resolveForFail({ reasonId, reasonNote, attemptType }) {
  const id = Number(reasonId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError('Select a fail reason before marking the attempt failed');
  }

  await ensureDefaultReasons();
  const row = await attemptFailReason.findByPk(id);
  if (!row || row.status === false) {
    throw new ValidationError('That fail reason is no longer available. Choose another.');
  }
  if (!scopeMatches(row.scope, attemptType)) {
    throw new ValidationError('That fail reason does not apply to this attempt type');
  }

  const note = String(reasonNote || '').trim();
  if ((row.requiresNote || row.isOther) && note.length < 3) {
    throw new ValidationError('Add a short note for this reason (at least 3 characters)');
  }
  if (note.length > 500) {
    throw new ValidationError('Reason note must be 500 characters or fewer');
  }

  const label = String(row.label || '').trim();
  const displayReason = note ? `${label}: ${note}` : label;

  return {
    id: row.id,
    code: row.code,
    label,
    description: row.description || null,
    chargesFee: Boolean(row.chargesFee),
    requiresNote: Boolean(row.requiresNote),
    isOther: Boolean(row.isOther),
    note: note || null,
    displayReason,
  };
}

async function createAdmin(payload = {}) {
  const label = String(payload.label || '').trim();
  if (label.length < 2) {
    throw new ValidationError('Reason label is required');
  }

  const scope = normalizeScope(payload.scope) || 'both';
  const description = String(payload.description || '').trim() || null;
  const chargesFee = payload.chargesFee === true;
  const requiresNote = payload.requiresNote === true || payload.isOther === true;
  const isOther = payload.isOther === true;
  const sortOrder =
    payload.sortOrder != null && Number.isFinite(Number(payload.sortOrder))
      ? Number(payload.sortOrder)
      : 80;

  let code = slugifyCode(payload.code || label);
  if (!code) code = `reason_${Date.now()}`;
  const clash = await attemptFailReason.findOne({ where: { code } });
  if (clash) {
    code = `${code}_${Date.now().toString().slice(-4)}`;
  }

  const row = await attemptFailReason.create({
    code,
    label,
    description,
    scope,
    chargesFee,
    requiresNote,
    isOther,
    sortOrder,
    status: payload.status !== false,
  });
  return toPublic(row);
}

async function updateAdmin(id, payload = {}) {
  const row = await attemptFailReason.findByPk(id);
  if (!row) {
    throw new ValidationError('Fail reason not found');
  }

  const patch = {};
  if (payload.label != null) {
    const label = String(payload.label).trim();
    if (label.length < 2) throw new ValidationError('Reason label is required');
    patch.label = label;
  }
  if (payload.description !== undefined) {
    patch.description = String(payload.description || '').trim() || null;
  }
  if (payload.scope != null) {
    const scope = normalizeScope(payload.scope);
    if (!scope) throw new ValidationError('scope must be pickup, delivery, or both');
    patch.scope = scope;
  }
  if (payload.chargesFee !== undefined) {
    patch.chargesFee = payload.chargesFee === true;
  }
  if (payload.requiresNote !== undefined) {
    patch.requiresNote = payload.requiresNote === true;
  }
  if (payload.isOther !== undefined) {
    patch.isOther = payload.isOther === true;
  }
  if (payload.sortOrder !== undefined) {
    patch.sortOrder = Number(payload.sortOrder) || 0;
  }
  if (payload.status !== undefined) {
    patch.status = payload.status !== false && payload.status !== 0;
  }

  await row.update(patch);
  return toPublic(row);
}

function applyReasonToFee(feeResult, resolved) {
  if (resolved.chargesFee) {
    return {
      ...feeResult,
      reasonChargesFee: true,
    };
  }

  return {
    ...feeResult,
    feeAmount: 0,
    feeWaived: true,
    feeWaiveReason: `No fee for reason: ${resolved.label}`,
    policyApplied: 'reason_no_fee',
    reasonChargesFee: false,
  };
}

module.exports = {
  ensureDefaultReasons,
  listEnabledForAttemptType,
  listAdmin,
  resolveForFail,
  createAdmin,
  updateAdmin,
  applyReasonToFee,
  toPublic,
};

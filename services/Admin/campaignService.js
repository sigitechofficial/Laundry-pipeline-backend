'use strict';

const { campaign: Campaign, promotion: Promotion, promotionAuditLog: AuditLog } = require('../../models');
const { Op } = require('sequelize');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');

// ─── Audit helper ────────────────────────────────────────────────────────────

async function audit(entityType, entityId, action, actorId, { oldValue, newValue, reason } = {}) {
  try {
    await AuditLog.create({
      entityType,
      entityId,
      action,
      actorId,
      actorType: actorId ? 'admin' : 'system',
      oldValue: oldValue || null,
      newValue: newValue || null,
      reason: reason || null,
    });
  } catch (err) {
    console.error('[AuditLog] Failed to write:', err.message);
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

const blankToNull = (v) => (v === '' || v === undefined ? null : v);

async function createCampaign(payload, adminUserId) {
  _validateCampaign(payload);

  const row = await Campaign.create({
    name: payload.name.trim(),
    description: payload.description || null,
    objective: payload.objective || null,
    channel: payload.channel || null,
    budgetMinor: blankToNull(payload.budgetMinor) == null ? null : Number(payload.budgetMinor),
    currency: payload.currency || 'GBP',
    startDate: blankToNull(payload.startDate),
    endDate: blankToNull(payload.endDate),
    status: payload.status || 'draft',
    createdBy: adminUserId,
    updatedBy: adminUserId,
  });

  await audit('campaign', row.id, 'created', adminUserId, { newValue: row.toJSON() });
  return row;
}

async function listCampaigns({ page = 1, limit = 50, status } = {}) {
  const where = {};
  if (status) where.status = status;

  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const { count, rows } = await Campaign.findAndCountAll({
    where,
    order: [['id', 'DESC']],
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
    distinct: true,
    include: [{ model: Promotion, as: 'promotions', attributes: ['id', 'name', 'status', 'benefitType'] }],
  });

  return { count, rows, page: safePage, limit: safeLimit };
}

async function getCampaignById(id) {
  const row = await Campaign.findByPk(id, {
    include: [{ model: Promotion, as: 'promotions', attributes: ['id', 'name', 'status', 'benefitType', 'discountValue', 'startDate', 'endDate'] }],
  });
  if (!row) throw new NotFoundError('Campaign not found');
  return row;
}

async function updateCampaign(id, payload, adminUserId) {
  const row = await getCampaignById(id);
  const oldValue = row.toJSON();

  _validateCampaign({ ...row.toJSON(), ...payload });

  await row.update({
    ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
    ...(payload.description !== undefined ? { description: payload.description } : {}),
    ...(payload.objective !== undefined ? { objective: payload.objective } : {}),
    ...(payload.channel !== undefined ? { channel: payload.channel } : {}),
    ...(payload.budgetMinor !== undefined ? { budgetMinor: blankToNull(payload.budgetMinor) == null ? null : Number(payload.budgetMinor) } : {}),
    ...(payload.currency !== undefined ? { currency: payload.currency } : {}),
    ...(payload.startDate !== undefined ? { startDate: blankToNull(payload.startDate) } : {}),
    ...(payload.endDate !== undefined ? { endDate: blankToNull(payload.endDate) } : {}),
    ...(payload.status !== undefined ? { status: payload.status } : {}),
    updatedBy: adminUserId,
  });

  await audit('campaign', id, 'updated', adminUserId, { oldValue, newValue: row.toJSON() });
  return row.reload();
}

async function deleteCampaign(id, adminUserId) {
  const row = await getCampaignById(id);

  // Can only archive, not hard delete, if has promotions
  const promoCount = await Promotion.count({ where: { campaignId: id } });
  if (promoCount > 0) {
    await row.update({ status: 'archived', updatedBy: adminUserId });
    await audit('campaign', id, 'archived', adminUserId, { reason: 'Soft delete — has promotions' });
    return { archived: true };
  }

  await row.destroy();
  await audit('campaign', id, 'deleted', adminUserId);
  return { deleted: true };
}

// ─── Validation ──────────────────────────────────────────────────────────────

function _validateCampaign(p) {
  if (!p.name || !String(p.name).trim()) throw new ValidationError('Campaign name is required');
  const validStatuses = ['draft', 'active', 'paused', 'completed', 'archived'];
  if (p.status && !validStatuses.includes(p.status)) {
    throw new ValidationError(`Invalid campaign status: ${p.status}`);
  }
  const budget = blankToNull(p.budgetMinor);
  if (budget != null && (!Number.isInteger(Number(budget)) || Number(budget) < 0)) {
    throw new ValidationError('Budget must be a whole number of pence ≥ 0');
  }
  const start = blankToNull(p.startDate) ? new Date(p.startDate) : null;
  const end = blankToNull(p.endDate) ? new Date(p.endDate) : null;
  if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) throw new ValidationError('Invalid start or end date');
  if (start && end && end <= start) throw new ValidationError('End date must be after the start date');
}

module.exports = {
  createCampaign,
  listCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
};

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

async function createCampaign(payload, adminUserId) {
  _validateCampaign(payload);

  const row = await Campaign.create({
    name: payload.name.trim(),
    description: payload.description || null,
    objective: payload.objective || null,
    channel: payload.channel || null,
    budgetMinor: payload.budgetMinor || null,
    currency: payload.currency || 'GBP',
    startDate: payload.startDate || null,
    endDate: payload.endDate || null,
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

  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
  const { count, rows } = await Campaign.findAndCountAll({
    where,
    order: [['id', 'DESC']],
    limit: Number(limit),
    offset,
    include: [{ model: Promotion, as: 'promotions', attributes: ['id', 'name', 'status', 'benefitType'] }],
  });

  return { count, rows, page: Number(page), limit: Number(limit) };
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

  if (payload.name !== undefined) _validateCampaign({ ...row.toJSON(), ...payload });

  await row.update({
    ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
    ...(payload.description !== undefined ? { description: payload.description } : {}),
    ...(payload.objective !== undefined ? { objective: payload.objective } : {}),
    ...(payload.channel !== undefined ? { channel: payload.channel } : {}),
    ...(payload.budgetMinor !== undefined ? { budgetMinor: payload.budgetMinor } : {}),
    ...(payload.currency !== undefined ? { currency: payload.currency } : {}),
    ...(payload.startDate !== undefined ? { startDate: payload.startDate } : {}),
    ...(payload.endDate !== undefined ? { endDate: payload.endDate } : {}),
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
}

module.exports = {
  createCampaign,
  listCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
};

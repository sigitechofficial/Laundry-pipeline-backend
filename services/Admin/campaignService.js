'use strict';

const { campaign: Campaign, promotion: Promotion, promotionAuditLog: AuditLog } = require('../../models');
const { Op } = require('sequelize');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');
const { CAMPAIGN_STATUSES, campaignBlock, budgetLeftMinor, businessToday, dayOf } = require('../promotions/campaignRules');
const { heldBudgetByCampaign } = require('../promotions/campaignBudget');

/** Promotion fields the campaign screens show. */
const PROMOTION_SUMMARY = [
  'id', 'name', 'status', 'benefitType', 'discountValue', 'discountMode', 'activationType', 'visibility',
  'startDate', 'endDate', 'globalUsedCount', 'globalUsageLimit', 'zoneScopeMode',
];

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
  _assertCanBeActive(payload);

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

/** Shared budgets only: an offer's own budget (ownerPromotionId) is managed on the offer. */
async function listCampaigns({ page = 1, limit = 50, status } = {}) {
  const where = { ownerPromotionId: null };
  if (status) where.status = status;

  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const { count, rows } = await Campaign.findAndCountAll({
    where,
    order: [['id', 'DESC']],
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
    distinct: true,
    include: [{ model: Promotion, as: 'promotions', attributes: PROMOTION_SUMMARY }],
  });

  await withRunning(rows);
  return { count, rows, page: safePage, limit: safeLimit };
}

/**
 * Adds to each campaign (as plain fields on the row):
 *   heldBudgetMinor / budgetLeftMinor — budget held by unpaid orders and what is left,
 *   running — whether new orders can use its promotions now,
 *   stopReason — why not (e.g. CAMPAIGN_NOT_ACTIVE, CAMPAIGN_ENDED), or null.
 */
async function withRunning(rows, now = new Date()) {
  const list = Array.isArray(rows) ? rows : [rows];
  const held = await heldBudgetByCampaign(list.filter((c) => c.budgetMinor != null).map((c) => c.id), { now });
  for (const c of list) {
    c.setDataValue('heldBudgetMinor', held.get(Number(c.id)) || 0);
    c.setDataValue('budgetLeftMinor', budgetLeftMinor(c));
    const stop = campaignBlock(c, now);
    c.setDataValue('running', !stop);
    c.setDataValue('stopReason', stop ? stop.code : null);
  }
  return rows;
}

async function getCampaignById(id) {
  const row = await findCampaign(id);
  await withRunning(row);
  return row;
}

async function findCampaign(id) {
  const row = await Campaign.findByPk(id, {
    include: [{ model: Promotion, as: 'promotions', attributes: PROMOTION_SUMMARY }],
  });
  if (!row) throw new NotFoundError('Campaign not found');
  return row;
}

async function updateCampaign(id, payload, adminUserId) {
  const row = await findCampaign(id);
  const oldValue = row.toJSON();

  _validateCampaign({ ...row.toJSON(), ...payload });
  if (payload.status !== undefined || payload.endDate !== undefined) _assertCanBeActive({ ...row.toJSON(), ...payload });

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
  return getCampaignById(id);
}

/**
 * Only an empty campaign is deleted. One with promotions is never removed or archived
 * silently: archiving stops every promotion in it, so the admin does that on purpose.
 */
async function deleteCampaign(id, adminUserId) {
  const row = await findCampaign(id);

  const promoCount = await Promotion.count({ where: { campaignId: id } });
  if (promoCount > 0) {
    throw new ValidationError(
      `This campaign has ${promoCount} promotion${promoCount === 1 ? '' : 's'}, so it cannot be deleted. Archive it instead (this stops its promotions), or move the promotions to another campaign first.`
    );
  }

  await row.destroy();
  await audit('campaign', id, 'deleted', adminUserId);
  return { deleted: true };
}

// ─── Validation ──────────────────────────────────────────────────────────────

function _validateCampaign(p) {
  if (!p.name || !String(p.name).trim()) throw new ValidationError('Campaign name is required');
  if (p.status && !CAMPAIGN_STATUSES.includes(p.status)) {
    throw new ValidationError(`Invalid campaign status: ${p.status}`);
  }
  const budget = blankToNull(p.budgetMinor);
  if (budget != null && (!Number.isInteger(Number(budget)) || Number(budget) < 0)) {
    throw new ValidationError('Budget must be a whole number of pence ≥ 0');
  }
  const start = blankToNull(p.startDate) ? new Date(p.startDate) : null;
  const end = blankToNull(p.endDate) ? new Date(p.endDate) : null;
  if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) throw new ValidationError('Invalid start or end date');
  // Calendar days (DATEONLY): a campaign may start and end on the same day.
  if (start && end && end < start) throw new ValidationError('End date must be on or after the start date');
}

/** Made (or kept) active, a campaign must still have days to run, or its promotions never apply. */
function _assertCanBeActive(p) {
  const endDay = dayOf(p.endDate);
  if (p.status === 'active' && endDay && endDay < businessToday()) {
    throw new ValidationError('This campaign has already ended. Change the end date to make it active again.');
  }
}

module.exports = {
  withRunning,
  createCampaign,
  listCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
};

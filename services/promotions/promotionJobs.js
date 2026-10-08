'use strict';

/**
 * Background work for promotions:
 *  - scheduled → active when startDate is reached
 *  - active/scheduled/paused → expired when endDate has passed
 *  - release checkout reservations whose TTL expired (frees usage counters)
 * Safe to run on several instances: status updates are conditional and
 * releases lock each redemption row.
 */

const { Op } = require('sequelize');
const { promotion: Promotion, promotionAuditLog: AuditLog } = require('../../models');
const { cleanupExpiredReservations } = require('./redemptionService');

const DEFAULT_INTERVAL_MS = 60 * 1000;
let timer = null;

async function audit(ids, action, reason) {
  for (const entityId of ids) {
    try {
      await AuditLog.create({ entityType: 'promotion', entityId, action, actorType: 'system', reason });
    } catch (err) {
      console.error('[promotionJobs] audit write failed:', err.message);
    }
  }
}

async function transitionWhere(where, status, action, reason) {
  const rows = await Promotion.findAll({ where, attributes: ['id'] });
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const [count] = await Promotion.update({ status }, { where: { ...where, id: ids } });
  await audit(ids, action, reason);
  return count;
}

async function runPromotionLifecycle(now = new Date()) {
  const activated = await transitionWhere(
    { status: 'scheduled', startDate: { [Op.lte]: now }, [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: now } }] },
    'active', 'status_active', 'Start date reached'
  );
  const expired = await transitionWhere(
    { status: { [Op.in]: ['scheduled', 'active', 'paused'] }, endDate: { [Op.lt]: now } },
    'expired', 'status_expired', 'End date passed'
  );
  return { activated, expired };
}

function startPromotionJobs() {
  if (timer) return;
  const intervalMs = Number(process.env.PROMOTION_JOB_INTERVAL_MS || DEFAULT_INTERVAL_MS);

  const run = async () => {
    try {
      const lifecycle = await runPromotionLifecycle();
      const cleanup = await cleanupExpiredReservations();
      if (lifecycle.activated || lifecycle.expired || cleanup.cleaned) {
        console.log(`[promotionJobs] activated=${lifecycle.activated} expired=${lifecycle.expired} releasedReservations=${cleanup.cleaned}`);
      }
    } catch (err) {
      console.error('[promotionJobs] failed:', err.message);
    }
  };

  setTimeout(run, 30 * 1000);
  timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[promotionJobs] started intervalMs=${intervalMs}`);
}

module.exports = { startPromotionJobs, runPromotionLifecycle };

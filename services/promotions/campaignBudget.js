'use strict';

/**
 * Budget held by open orders: holds (RESERVED) already priced at invoice but not paid yet.
 * Committed spend lives on campaigns.usedBudgetMinor; together they are what the budget
 * has given away, so new orders stop before the budget is passed.
 */

const { sequelize } = require('../../models');

/**
 * @param {number[]} campaignIds
 * @param {{ now?: Date, excludeBookingId?: number|null, transaction?: object }} [opts]
 * @returns {Promise<Map<number, number>>} campaignId → held pence
 */
async function heldBudgetByCampaign(campaignIds, { now = new Date(), excludeBookingId = null, transaction } = {}) {
  const ids = [...new Set((campaignIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length) return out;
  const rows = await sequelize.query(
    `SELECT p.campaignId AS campaignId,
            COALESCE(SUM(ROUND((COALESCE(r.discountAmount, 0) + COALESCE(r.cashbackAmount, 0)) * 100)), 0) AS heldMinor
       FROM promotion_redemptions r
       JOIN promotions p ON p.id = r.promotionId
      WHERE p.campaignId IN (:ids)
        AND r.status = 'RESERVED'
        AND r.reservationExpiresAt > :now
        ${excludeBookingId ? 'AND (r.bookingId IS NULL OR r.bookingId <> :excludeBookingId)' : ''}
      GROUP BY p.campaignId`,
    {
      replacements: { ids, now, excludeBookingId: excludeBookingId ? Number(excludeBookingId) : null },
      type: sequelize.QueryTypes.SELECT,
      transaction,
    }
  );
  for (const r of rows) out.set(Number(r.campaignId), Number(r.heldMinor) || 0);
  return out;
}

/** Put each loaded promotion's campaign hold total on the campaign (as heldBudgetMinor). */
async function attachHeldBudget(promotions, opts = {}) {
  const withBudget = (promotions || []).filter((p) => p.campaign && p.campaign.budgetMinor != null);
  if (!withBudget.length) return promotions;
  const held = await heldBudgetByCampaign(withBudget.map((p) => p.campaign.id), opts);
  for (const p of withBudget) {
    const minor = held.get(Number(p.campaign.id)) || 0;
    if (typeof p.campaign.setDataValue === 'function') p.campaign.setDataValue('heldBudgetMinor', minor);
    else p.campaign.heldBudgetMinor = minor;
  }
  return promotions;
}

module.exports = { heldBudgetByCampaign, attachHeldBudget };

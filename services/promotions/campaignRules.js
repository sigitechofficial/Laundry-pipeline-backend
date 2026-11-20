'use strict';

/**
 * When a campaign lets its promotions run. One rule, used by the engine (offers,
 * checkout, booking holds, invoice) and by the ledger (reserving a hold).
 *
 * A new order may use a campaign's promotion only while the campaign is:
 *   - active (draft, paused, completed and archived all stop it),
 *   - inside its start/end days (UK calendar days, both days included),
 *   - within budget: spent + priced unpaid holds is below the budget.
 *
 * An order that already holds the promotion keeps it: pausing, archiving or completing the
 * campaign or its end date passing stop new orders only. Same rule as for the promotion
 * itself (promotionEngine.loadHeldPromotions).
 *
 * The budget is a hard cap. A hold has no amount until the shop prices the order, so at
 * invoice what the order's promotions give is limited to what the campaign has left
 * (capToCampaignBudgets): the last order may get part of the offer, never more than the budget.
 */

const moment = require('moment-timezone');
const { DEFAULT_PROMOTION_TIME_ZONE } = require('./promotionTime');
const { allocateMinor, fromMinor } = require('./moneyUtils');

const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'completed', 'archived'];
/** A promotion cannot be put into (or published in) a campaign in these statuses. */
const CLOSED_STATUSES = ['completed', 'archived'];

/** Read a field from a Sequelize instance or a plain row. */
function field(row, key) {
  if (!row) return undefined;
  if (typeof row.get === 'function') return row.get(key);
  return row[key];
}

/** 'YYYY-MM-DD' of a DATEONLY value, whether the driver returns a string or a Date. */
function dayOf(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : moment.utc(value).format('YYYY-MM-DD');
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Today's UK calendar day. */
function businessToday(now = new Date()) {
  return moment(now).tz(DEFAULT_PROMOTION_TIME_ZONE).format('YYYY-MM-DD');
}

/** Budget already taken: committed spend plus priced holds of unpaid orders (pence). */
function budgetTakenMinor(campaign) {
  return Number(field(campaign, 'usedBudgetMinor') || 0) + Number(field(campaign, 'heldBudgetMinor') || 0);
}

/** Pence left in the budget, or null when the campaign has no budget. */
function budgetLeftMinor(campaign) {
  const budget = field(campaign, 'budgetMinor');
  if (budget == null) return null;
  return Math.max(0, Number(budget) - budgetTakenMinor(campaign));
}

const REASONS = {
  CAMPAIGN_NOT_ACTIVE: 'This offer is not available right now',
  CAMPAIGN_NOT_STARTED: 'This offer has not started yet',
  CAMPAIGN_ENDED: 'This offer has ended',
  CAMPAIGN_BUDGET_EXHAUSTED: 'This offer is no longer available',
};

/**
 * Why the campaign stops its promotion, or null when it does not.
 * @param {object|null} campaign instance or plain row (no campaign → never blocks)
 * @param {Date} now
 * @param {{ held?: boolean, budget?: boolean }} [opts] held: an order already holds it;
 *   budget: false to leave the budget to the caller (it reports its own reason)
 * @returns {{ code: string, message: string }|null}
 */
function campaignBlock(campaign, now = new Date(), { held = false, budget = true } = {}) {
  if (!campaign) return null;
  const status = field(campaign, 'status');
  const out = (code) => ({ code, message: REASONS[code] });

  if (held) return null; // a booked order keeps its offer whatever happens to the campaign

  if (status !== 'active') return out('CAMPAIGN_NOT_ACTIVE');
  const today = businessToday(now);
  const start = dayOf(field(campaign, 'startDate'));
  const end = dayOf(field(campaign, 'endDate'));
  if (start && today < start) return out('CAMPAIGN_NOT_STARTED');
  if (end && today > end) return out('CAMPAIGN_ENDED');
  if (budget && budgetLeftMinor(campaign) === 0) return out('CAMPAIGN_BUDGET_EXHAUSTED');
  return null;
}

/**
 * Hard budget cap at invoice. What an order's promotions give (discount + cashback) never
 * passes what their campaign has left. Promotions of one campaign share it in proportion to
 * their savings; inside a promotion, discount, cashback and the discount's lines shrink in
 * the same proportion.
 *
 * @param {Array<{promotionId:number,totalSavingMinor:number,cashbackMinor?:number,adjustments?:Array}>} applied
 * @param {Map<number,{campaignId:number,leftMinor:number}>} budgetOf promotionId → its campaign
 *   and the pence it has left (only promotions whose campaign has a budget)
 * @returns {{ applied: Array, cappedIds: Set<number> }} cappedIds — promotions given less than in full
 */
function capToCampaignBudgets(applied, budgetOf) {
  const groups = new Map();
  applied.forEach((a, i) => {
    const b = budgetOf.get(Number(a.promotionId));
    if (!b) return;
    if (!groups.has(b.campaignId)) groups.set(b.campaignId, { leftMinor: Math.max(0, Number(b.leftMinor) || 0), idx: [] });
    groups.get(b.campaignId).idx.push(i);
  });
  const out = applied.slice();
  const cappedIds = new Set();
  for (const { leftMinor, idx } of groups.values()) {
    const costs = idx.map((i) => (applied[i].totalSavingMinor || 0) + (applied[i].cashbackMinor || 0));
    if (costs.reduce((s, v) => s + v, 0) <= leftMinor) continue;
    const shares = allocateMinor(leftMinor, costs);
    idx.forEach((i, k) => {
      const a = applied[i];
      const [saving, cashback] = allocateMinor(shares[k], [a.totalSavingMinor || 0, a.cashbackMinor || 0]);
      const lines = a.adjustments || [];
      const lineShares = allocateMinor(saving, lines.map((adj) => Math.abs(adj.amountMinor || 0)));
      out[i] = {
        ...a,
        totalSavingMinor: saving,
        totalSaving: fromMinor(saving),
        cashbackMinor: cashback,
        cashbackAmount: fromMinor(cashback),
        adjustments: lines.map((adj, j) => ({ ...adj, amountMinor: -lineShares[j], amount: -fromMinor(lineShares[j]) })),
      };
      if (saving + cashback < costs[k]) cappedIds.add(Number(a.promotionId));
    });
  }
  return { applied: out, cappedIds };
}

module.exports = {
  capToCampaignBudgets,
  CAMPAIGN_STATUSES,
  CLOSED_STATUSES,
  campaignBlock,
  budgetLeftMinor,
  budgetTakenMinor,
  businessToday,
  dayOf,
};

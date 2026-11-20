'use strict';

/**
 * When a campaign lets its promotions run. One rule, used by the engine (offers,
 * checkout, booking holds, invoice) and by the ledger (reserving a hold).
 *
 * A new order may use a campaign's promotion only while the campaign is:
 *   - active (draft, paused, completed and archived all stop it),
 *   - inside its start/end days (UK calendar days, both days included),
 *   - within budget: spent + unpaid holds (priced amount, or the estimate until priced) leaves
 *     room for this order's estimate (the offer on a minimum order).
 *
 * An order that already holds the promotion always keeps its full offer (the customer was
 * promised it, and its estimate was held against the budget): pausing, archiving or
 * completing the campaign, its end date passing or its budget running out stop new orders
 * only. The budget may finish a little over when real orders are bigger than the estimate. Same
 * rule as for the promotion itself (promotionEngine.loadHeldPromotions).
 */

const moment = require('moment-timezone');
const { DEFAULT_PROMOTION_TIME_ZONE } = require('./promotionTime');

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

module.exports = {
  CAMPAIGN_STATUSES,
  CLOSED_STATUSES,
  campaignBlock,
  budgetLeftMinor,
  budgetTakenMinor,
  businessToday,
  dayOf,
};

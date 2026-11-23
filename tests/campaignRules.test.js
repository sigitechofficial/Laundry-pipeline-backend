'use strict';

/**
 * Campaign rules: when a campaign lets its promotions run (status, days, budget), and
 * that orders already holding a promotion keep it. Pure (models stubbed), so it runs in CI.
 * Run: node tests/campaignRules.test.js
 */

const assert = require('assert');
const Module = require('module');

// Models stub with a sequelize.query that answers the held-budget query.
let heldRows = [];
let lastQuery = null;
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '../models' || request === '../../models' || /[\\/]models$/.test(request)) {
    return {
      sequelize: {
        QueryTypes: { SELECT: 'SELECT' },
        query: async (sql, opts) => { lastQuery = { sql, opts }; return heldRows; },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  campaignBlock, budgetLeftMinor, daysIn, campaignEndedEverywhere, dayOf, CLOSED_STATUSES,
} = require('../services/promotions/campaignRules');
const { heldBudgetByCampaign, attachHeldBudget } = require('../services/promotions/campaignBudget');
const { builtInCheck } = require('../services/promotions/promotionEngine');

const NOW = new Date('2026-12-05T12:00:00Z'); // Saturday 5 Dec 2026, UK
const LONDON = 'Europe/London';
const KARACHI = 'Asia/Karachi'; // UTC+5
const AUCKLAND = 'Pacific/Auckland'; // UTC+13 in December
const camp = (extra = {}) => ({ id: 7, status: 'active', startDate: null, endDate: null, budgetMinor: null, usedBudgetMinor: 0, ...extra });
// An order in a London zone unless the test says otherwise.
const codeOf = (c, opts = {}) => (campaignBlock(c, NOW, { timeZones: [LONDON], ...opts }) || {}).code || null;

(async () => {
  // ─── Days ────────────────────────────────────────────────────────────────
  assert.deepStrictEqual(daysIn(new Date('2026-07-04T23:30:00Z'), [LONDON]), ['2026-07-05'], 'UK day, not UTC (summer, after 23:00 UTC)');
  assert.deepStrictEqual(daysIn(NOW, [LONDON, AUCKLAND]), ['2026-12-05', '2026-12-06'], 'each zone on its own day');
  assert.throws(() => daysIn(NOW, []), /No time zone/, 'no zone: refused, never assumed');
  assert.throws(() => daysIn(NOW, [null]), /No valid IANA time zone/);
  assert.strictEqual(dayOf('2026-12-01'), '2026-12-01');
  assert.strictEqual(dayOf(new Date('2026-12-01T00:00:00Z')), '2026-12-01', 'DATEONLY returned as a Date');
  assert.strictEqual(dayOf(''), null);

  // ─── New orders: status ──────────────────────────────────────────────────
  assert.strictEqual(codeOf(null), null, 'no campaign never blocks');
  assert.strictEqual(codeOf(camp()), null, 'active campaign runs');
  for (const status of ['draft', 'paused', 'completed', 'archived']) {
    assert.strictEqual(codeOf(camp({ status })), 'CAMPAIGN_NOT_ACTIVE', `${status} campaign stops its promotions`);
  }

  // ─── New orders: days (both days included) ───────────────────────────────
  assert.strictEqual(codeOf(camp({ startDate: '2026-12-06' })), 'CAMPAIGN_NOT_STARTED');
  assert.strictEqual(codeOf(camp({ startDate: '2026-12-05' })), null, 'runs on its start day');
  assert.strictEqual(codeOf(camp({ endDate: '2026-12-05' })), null, 'runs on its end day');
  assert.strictEqual(codeOf(camp({ endDate: '2026-12-04' })), 'CAMPAIGN_ENDED', 'stops the day after its end day');
  assert.strictEqual(
    (campaignBlock(camp({ endDate: '2026-12-04' }), new Date('2026-12-04T23:30:00Z'), { timeZones: [LONDON] }) || {}).code || null,
    null,
    '23:30 UTC on 4 Dec is still 4 Dec in winter UK'
  );

  // ─── Days in a non-UK zone: the order's own zone clock ───────────────────
  const lateEvening = new Date('2026-12-04T20:30:00Z'); // 01:30 on 5 Dec in Karachi
  const endedDec4 = camp({ endDate: '2026-12-04' });
  assert.strictEqual((campaignBlock(endedDec4, lateEvening, { timeZones: [KARACHI] }) || {}).code, 'CAMPAIGN_ENDED', 'already 5 Dec in Karachi');
  assert.strictEqual(campaignBlock(endedDec4, lateEvening, { timeZones: [LONDON] }), null, 'still 4 Dec in London');
  assert.strictEqual(codeOf(camp({ startDate: '2026-12-06' }), { timeZones: [AUCKLAND] }), null, 'already 6 Dec in Auckland');
  // No single zone (admin views, lifecycle job): started anywhere, ended everywhere.
  assert.strictEqual(codeOf(camp({ endDate: '2026-12-05' }), { timeZones: [LONDON, AUCKLAND] }), null, 'not over in London yet');
  assert.strictEqual(codeOf(camp({ startDate: '2026-12-06' }), { timeZones: [LONDON, AUCKLAND] }), null, 'started in Auckland');
  assert.strictEqual(campaignEndedEverywhere('2026-12-05', NOW, [LONDON, AUCKLAND]), false);
  assert.strictEqual(campaignEndedEverywhere('2026-12-05', NOW, [AUCKLAND]), true);
  assert.strictEqual(campaignEndedEverywhere(null, NOW, [LONDON]), false, 'no end day never ends');
  // A dated campaign without a zone to read the day in fails clearly.
  assert.throws(() => campaignBlock(camp({ endDate: '2026-12-05' }), NOW), /No time zone/);
  assert.strictEqual(campaignBlock(camp(), NOW), null, 'an undated campaign needs no zone');

  // ─── New orders: budget = spent + priced unpaid holds ────────────────────
  assert.strictEqual(budgetLeftMinor(camp()), null, 'no budget = no limit');
  assert.strictEqual(budgetLeftMinor(camp({ budgetMinor: 50000, usedBudgetMinor: 49000 })), 1000);
  assert.strictEqual(budgetLeftMinor(camp({ budgetMinor: 50000, usedBudgetMinor: 49000, heldBudgetMinor: 1500 })), 0, 'never below 0');
  assert.strictEqual(codeOf(camp({ budgetMinor: 50000, usedBudgetMinor: 49000 })), null, '£10 left: still runs');
  assert.strictEqual(codeOf(camp({ budgetMinor: 50000, usedBudgetMinor: 49000, heldBudgetMinor: 1000 })), 'CAMPAIGN_BUDGET_EXHAUSTED', 'held orders use up the rest');
  assert.strictEqual(codeOf(camp({ budgetMinor: 0 })), 'CAMPAIGN_BUDGET_EXHAUSTED', '£0 budget gives nothing');
  assert.strictEqual(codeOf(camp({ budgetMinor: 100, usedBudgetMinor: 100 }), { budget: false }), null, 'budget can be left to the caller');
  // Sequelize instance shape (get())
  const instance = { get: (k) => camp({ budgetMinor: 100, usedBudgetMinor: 100 })[k] };
  assert.strictEqual(codeOf(instance), 'CAMPAIGN_BUDGET_EXHAUSTED', 'reads Sequelize instances');

  // ─── Orders that already hold the promotion ──────────────────────────────
  assert.strictEqual(codeOf(camp({ status: 'completed', endDate: '2026-11-01' }), { held: true }), null, 'booked order keeps it after the campaign ended');
  assert.strictEqual(codeOf(camp({ budgetMinor: 100, usedBudgetMinor: 900 }), { held: true }), null, 'booked order keeps it after the budget ran out');
  assert.strictEqual(codeOf(camp({ status: 'draft' }), { held: true }), null);
  assert.strictEqual(codeOf(camp({ status: 'paused' }), { held: true }), null, 'pausing stops new orders only');
  assert.strictEqual(codeOf(camp({ status: 'archived' }), { held: true }), null, 'archiving stops new orders only');
  assert.deepStrictEqual(CLOSED_STATUSES, ['completed', 'archived']);

  // ─── Engine built-in check: budget message, skipped for holds ────────────
  const promo = (campaign) => ({ id: 1, benefitType: 'percentage_discount', discountValue: 10, currency: 'GBP', campaign });
  const ctx = { basket: { subtotal: 40, itemCount: 4 }, customer: { orderCount: 3 } };
  const spent = camp({ budgetMinor: 5000, usedBudgetMinor: 4000, heldBudgetMinor: 1000 });
  assert.strictEqual(builtInCheck(promo(spent), ctx, null, new Map())?.code, 'PROMOTION_BUDGET_EXHAUSTED', 'new order: budget used up');
  assert.strictEqual(builtInCheck(promo(spent), ctx, null, new Map(), { skipUsageLimits: true }), null, 'held order: budget not re-checked');
  assert.strictEqual(builtInCheck(promo(camp({ budgetMinor: 5000, usedBudgetMinor: 4000 })), ctx, null, new Map()), null, 'budget left: passes');
  assert.strictEqual(builtInCheck(promo(null), ctx, null, new Map()), null, 'no campaign: passes');

  // ─── Held budget query ───────────────────────────────────────────────────
  heldRows = [{ campaignId: 7, heldMinor: '1250' }];
  const held = await heldBudgetByCampaign([7, '7', 0, null], { now: NOW, excludeBookingId: 55 });
  assert.strictEqual(held.get(7), 1250, 'held pence per campaign');
  assert.deepStrictEqual(lastQuery.opts.replacements.ids, [7], 'ids cleaned and de-duplicated');
  assert.ok(/r\.status = 'RESERVED'/.test(lastQuery.sql) && /reservationExpiresAt > :now/.test(lastQuery.sql), 'only live holds count');
  assert.ok(/r\.bookingId <> :excludeBookingId/.test(lastQuery.sql), 'the booking being priced is left out');

  lastQuery = null;
  assert.strictEqual((await heldBudgetByCampaign([])).size, 0);
  assert.strictEqual(lastQuery, null, 'no query without campaigns');

  const rows = [{ id: 1, campaign: { id: 7, budgetMinor: 5000 } }, { id: 2, campaign: { id: 8, budgetMinor: null } }, { id: 3, campaign: null }];
  await attachHeldBudget(rows, { now: NOW });
  assert.strictEqual(rows[0].campaign.heldBudgetMinor, 1250, 'attached to campaigns with a budget');
  assert.strictEqual(rows[1].campaign.heldBudgetMinor, undefined, 'no budget: nothing to attach');

  // Booking estimate: the offer on a minimum order (£20).
  const { holdEstimateMinor } = require('../services/promotions/benefitHandlers');
  assert.strictEqual(holdEstimateMinor({ benefitType: 'percentage_discount', discountValue: 10 }, null, 2000), 200, '10% of £20');
  assert.strictEqual(holdEstimateMinor({ benefitType: 'percentage_discount', discountValue: 50, maxDiscountCap: 5 }, null, 2000), 500, 'capped');
  assert.strictEqual(holdEstimateMinor({ benefitType: 'fixed_amount_discount', discountValue: 5 }, null, 2000), 500, '£5 off');
  assert.strictEqual(holdEstimateMinor({ benefitType: 'fixed_price', discountValue: 15 }, null, 2000), 500, '£15 for a £20 basket');
  assert.strictEqual(holdEstimateMinor({ benefitType: 'free_delivery', discountValue: 0 }, null, 2000), 0, 'delivery offers save nothing today');
  assert.strictEqual(holdEstimateMinor({ benefitType: 'percentage_discount', discountValue: 10 }, { discountValue: 20 }, 2000), 400, 'zone override');

  Module._load = originalLoad;
  console.log('✅ Campaign rules: all passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

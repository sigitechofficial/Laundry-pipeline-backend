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
  campaignBlock, budgetLeftMinor, businessToday, dayOf, CLOSED_STATUSES,
} = require('../services/promotions/campaignRules');
const { heldBudgetByCampaign, attachHeldBudget } = require('../services/promotions/campaignBudget');
const { builtInCheck } = require('../services/promotions/promotionEngine');

const NOW = new Date('2026-12-05T12:00:00Z'); // Saturday 5 Dec 2026, UK
const camp = (extra = {}) => ({ id: 7, status: 'active', startDate: null, endDate: null, budgetMinor: null, usedBudgetMinor: 0, ...extra });
const codeOf = (c, opts) => (campaignBlock(c, NOW, opts) || {}).code || null;

(async () => {
  // ─── Days ────────────────────────────────────────────────────────────────
  assert.strictEqual(businessToday(new Date('2026-07-04T23:30:00Z')), '2026-07-05', 'UK day, not UTC (summer, after 23:00 UTC)');
  assert.strictEqual(businessToday(NOW), '2026-12-05');
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
    (campaignBlock(camp({ endDate: '2026-12-04' }), new Date('2026-12-04T23:30:00Z')) || {}).code || null,
    null,
    '23:30 UTC on 4 Dec is still 4 Dec in winter UK'
  );

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

  Module._load = originalLoad;
  console.log('✅ Campaign rules: all passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

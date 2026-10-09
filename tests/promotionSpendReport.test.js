'use strict';

/**
 * Admin Reports → Promotions / Campaigns: spend per promotion and campaign.
 * Seeds archived promotions (never offered at checkout) with ledger rows on fixed
 * September dates, checks the numbers, filters, sort, zone scope and export, then cleans up.
 *
 *   NODE_ENV=development node tests/promotionSpendReport.test.js
 *   (also calls GET /admin/reports/promotions on the local API when it is running)
 */

const { QueryTypes } = require('sequelize');
const { createClient } = require('redis');
const models = require('../models');
const { signAdminAccessToken } = require('../utils/adminJwt');
const { promotionPerformance, campaignPerformance } = require('../services/promotions/promotionPerformanceService');
const { promotionReport, campaignReport } = require('../services/promotions/promotionReportService');

const { sequelize } = models;
const BASE = process.env.PROMO_TEST_BASE_URL || 'http://localhost:3010';
const RUN = Date.now() % 100000;
const TAG = `QA-SPEND-${RUN}`;
const SEPT = { period: 'custom', startDate: '2026-09-01', endDate: '2026-09-30' };

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const ids = { promotions: [], redemptions: [], coupons: [], campaign: null };

async function seed() {
  const camp = await models.campaign.create({ name: `${TAG} Campaign`, status: 'active', objective: 'retention', budgetMinor: 10000, usedBudgetMinor: 3000 });
  ids.campaign = camp.id;
  const base = { status: 'archived', currency: 'GBP', discountValue: 10 };
  const p1 = await models.promotion.create({ ...base, name: `${TAG} Basket zone 3`, benefitType: 'basket_discount', campaignId: camp.id, zoneScopeMode: 'selected', zoneIds: [3] });
  const p2 = await models.promotion.create({ ...base, name: `${TAG} Cashback all zones`, benefitType: 'cashback', campaignId: camp.id, zoneScopeMode: 'all' });
  const p3 = await models.promotion.create({ ...base, name: `${TAG} Another zone 1`, benefitType: 'basket_discount', zoneScopeMode: 'selected', zoneIds: [1] });
  ids.promotions = [p1.id, p2.id, p3.id];
  const coupon = await models.couponCode.create({ promotionId: p1.id, code: `QASPEND${RUN}`, isActive: true });
  ids.coupons.push(coupon.id);

  // [promotion, status, zone, customer, discount, cashback, committedAt, reversedAt]
  const rows = [
    [p1, 'COMMITTED', 3, 3, 5, null, '2026-09-10 12:00:00', null],
    [p1, 'COMMITTED', 3, 5, 7, null, '2026-09-20 12:00:00', null],
    [p1, 'REVERSED', 3, 6, 4, null, '2026-09-11 12:00:00', '2026-09-12 12:00:00'],
    [p1, 'RESERVED', 3, 6, 6, null, null, null],
    [p2, 'COMMITTED', 1, 3, 0, 3, '2026-09-15 12:00:00', null],
    [p2, 'COMMITTED', 3, 3, 0, 2, '2026-09-25 12:00:00', null],
    [p3, 'COMMITTED', 1, 6, 10, null, '2026-09-18 12:00:00', null],
  ];
  for (const [i, [p, status, zoneId, customerId, discount, cashback, committedAt, reversedAt]] of rows.entries()) {
    const [id] = await sequelize.query(
      `INSERT INTO promotion_redemptions
         (promotionId, customerId, status, discountAmount, cashbackAmount, currency, zoneId, idempotencyKey,
          reservedAt, reservationExpiresAt, committedAt, reversedAt, couponCode, createdAt, updatedAt)
       VALUES (:p, :customerId, :status, :discount, :cashback, 'GBP', :zoneId, :key,
          NOW(), :expires, :committedAt, :reversedAt, :code, NOW(), NOW())`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          p: p.id, customerId, status, discount, cashback, zoneId, key: `${TAG}-${i}`,
          expires: status === 'RESERVED' ? new Date(Date.now() + 3600e3) : null,
          committedAt, reversedAt, code: p === p1 ? `QASPEND${RUN}` : null,
        },
      }
    );
    ids.redemptions.push(id);
  }
  return { p1, p2, p3 };
}

async function cleanup() {
  if (ids.redemptions.length) await sequelize.query('DELETE FROM promotion_redemptions WHERE id IN (:ids)', { replacements: { ids: ids.redemptions } });
  if (ids.coupons.length) await models.couponCode.destroy({ where: { id: ids.coupons }, force: true });
  if (ids.promotions.length) await models.promotion.destroy({ where: { id: ids.promotions }, force: true });
  if (ids.campaign) await models.campaign.destroy({ where: { id: ids.campaign }, force: true });
}

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001;

async function main() {
  const { p1, p2, p3 } = await seed();
  const run = (extra = {}, scope = {}) => promotionPerformance({ ...SEPT, search: TAG, ...extra }, scope);

  let r = await run();
  const s = r.summary;
  check('three promotions found by name search', r.total === 3, `total=${r.total}`);
  check('summary: 5 paid uses, £22 discount, £5 cashback, £27 cost',
    s.uses === 5 && near(s.discount, 22) && near(s.cashback, 5) && near(s.cost, 27), JSON.stringify({ uses: s.uses, discount: s.discount, cashback: s.cashback, cost: s.cost }));
  check('summary: 3 distinct customers, 1 refund of £4, 1 order holding', s.customers === 3 && s.refunds === 1 && near(s.refundedAmount, 4) && s.holding === 1,
    JSON.stringify({ customers: s.customers, refunds: s.refunds, refundedAmount: s.refundedAmount, holding: s.holding }));
  check('top spender is the zone-3 basket promotion (£12)', s.topSpender?.id === p1.id && near(s.topSpender.cost, 12), JSON.stringify(s.topSpender));
  check('default sort: most spent first', r.data.map((x) => x.id).join() === [p1.id, p3.id, p2.id].join(), r.data.map((x) => `${x.id}:${x.cost}`).join(' '));
  const row1 = r.data.find((x) => x.id === p1.id);
  check('row: uses, average, campaign name and code', row1.uses === 2 && near(row1.averageCost, 6) && row1.campaignName === `${TAG} Campaign` && row1.codes === `QASPEND${RUN}`,
    JSON.stringify({ uses: row1.uses, averageCost: row1.averageCost, campaignName: row1.campaignName, codes: row1.codes }));
  check('spend split by benefit type', s.byBenefitType.find((b) => b.benefitType === 'basket_discount')?.cost === 22 && s.byBenefitType.find((b) => b.benefitType === 'cashback')?.cost === 5,
    JSON.stringify(s.byBenefitType));

  r = await run({ sort: 'cost', dir: 'asc' });
  check('least spent first', r.data[0].id === p2.id, r.data.map((x) => x.cost).join(' '));
  r = await run({ sort: 'uses' });
  check('most uses first (tie → more spent first)', r.data.map((x) => x.id).join() === [p1.id, p2.id, p3.id].join(), r.data.map((x) => `${x.uses}/${x.cost}`).join(' '));
  r = await run({ sort: 'name' });
  check('name A→Z', r.data.map((x) => x.name).join('|') === [...r.data.map((x) => x.name)].sort().join('|'), r.data.map((x) => x.name).join(' | '));
  r = await run({ sort: 'cashback' });
  check('most cashback first', r.data[0].id === p2.id);

  r = await run({ startDate: '2026-09-01', endDate: '2026-09-14', onlyUsed: '1' });
  check('custom 1–14 Sep, only used: one promotion, £5, refund counted on its refund date',
    r.total === 1 && near(r.summary.cost, 5) && r.summary.refunds === 1, JSON.stringify({ total: r.total, cost: r.summary.cost, refunds: r.summary.refunds }));
  r = await run({ period: 'custom', startDate: '2026-08-01', endDate: '2026-08-31', onlyUsed: '1' });
  check('a month with no uses: nothing listed', r.total === 0 && r.summary.cost === 0 && r.summary.topSpender === null);
  r = await run({ period: 'all' });
  check('all time = same totals', near(r.summary.cost, 27));

  r = await run({ zoneId: 1 });
  check('zone filter (zone 1): £13 (cashback £3 + basket £10)', near(r.summary.cost, 13), `cost=${r.summary.cost}`);
  r = await run({}, { restrictedZoneId: 3 });
  check('zone manager (zone 3): only promotions running in zone 3, only zone-3 money',
    r.total === 2 && !r.data.some((x) => x.id === p3.id) && near(r.summary.cost, 14), `total=${r.total} cost=${r.summary.cost}`);
  r = await run({ zoneId: 1 }, { restrictedZoneId: 3 });
  check('zone manager cannot pick another zone', r.filters.zoneId === 3);

  r = await promotionPerformance({ ...SEPT, search: `QASPEND${RUN}` });
  check('search by coupon code', r.total === 1 && r.data[0].id === p1.id);
  r = await promotionPerformance({ ...SEPT, search: `#${p3.id}` });
  check('search by #id', r.total === 1 && r.data[0].id === p3.id);
  r = await promotionPerformance({ ...SEPT, search: `${TAG} Campaign` });
  check('search by campaign name', r.total === 2);
  r = await run({ campaignId: 'none' });
  check('filter: not in a campaign', r.total === 1 && r.data[0].id === p3.id);
  r = await run({ campaignId: String(ids.campaign) });
  check('filter: one campaign', r.total === 2);
  r = await run({ benefitType: 'cashback' });
  check('filter: benefit type', r.total === 1 && r.data[0].id === p2.id);
  r = await run({ status: 'active' });
  check('filter: status', r.total === 0);
  r = await run({ sort: 'x; DROP TABLE promotions', dir: 'sideways', benefitType: "x' OR 1=1" });
  check('unknown sort / bad values are ignored', r.filters.sort === 'cost' && r.filters.dir === 'desc' && r.filters.benefitType === null);

  r = await run({ export: '1', limit: 2 });
  check('export returns every row (limit ignored, up to 5000)', r.data.length === 3 && r.limit === 5000 && r.truncated === false);
  r = await run({ limit: 2, page: 2 });
  check('pagination', r.data.length === 1 && r.total === 3 && r.page === 2);

  let c = await campaignPerformance({ ...SEPT, search: TAG });
  const cr = c.data[0];
  check('campaign: 2 promotions, 4 uses, £17 spent in period, 2 customers',
    c.total === 1 && cr?.promotions === 2 && cr.uses === 4 && near(cr.cost, 17) && cr.customers === 2,
    JSON.stringify({ total: c.total, promotions: cr?.promotions, uses: cr?.uses, cost: cr?.cost, customers: cr?.customers }));
  check('campaign budget: £100, £30 used (30%), £70 left', near(cr.budget, 100) && near(cr.budgetUsed, 30) && cr.percentUsed === 30 && near(cr.budgetRemaining, 70),
    JSON.stringify({ budget: cr.budget, used: cr.budgetUsed, pct: cr.percentUsed, left: cr.budgetRemaining }));
  check('campaign top spender', c.summary.topSpender?.id === ids.campaign);
  c = await campaignPerformance({ ...SEPT, search: TAG }, { restrictedZoneId: 3 });
  check('campaign for zone manager (zone 3): £14', near(c.data[0]?.cost, 14), `cost=${c.data[0]?.cost}`);
  c = await campaignPerformance({ ...SEPT, search: `${TAG} Basket` });
  check('campaign search by a promotion name', c.total === 1);
  c = await campaignPerformance({ ...SEPT, search: TAG, objective: 'acquisition' });
  check('campaign filter: objective', c.total === 0);
  c = await campaignPerformance({ ...SEPT });
  check('spend outside campaigns reported separately', c.summary.notInCampaign.cost >= 10, `notInCampaign=${JSON.stringify(c.summary.notInCampaign)}`);

  // One promotion's report: inRange limits every figure to the dates; without it the summary is all time.
  let pr = await promotionReport(p1.id, { from: '2026-09-01T00:00:00Z', to: '2026-09-14T23:59:59Z', inRange: '1', recentLimit: '5000' });
  check('promotion report in range (1–14 Sep): 1 use, £5, 1 refund, 1 order listed',
    pr.inRange && pr.summary.uses === 1 && near(pr.summary.totalDiscount, 5) && pr.summary.refunded === 1 && pr.recent.length === 1,
    JSON.stringify({ uses: pr.summary.uses, discount: pr.summary.totalDiscount, refunded: pr.summary.refunded, recent: pr.recent.length }));
  pr = await promotionReport(p1.id, { from: '2026-09-01T00:00:00Z', to: '2026-09-14T23:59:59Z' });
  check('promotion report without inRange keeps all-time summary (old admin builds)', !pr.inRange && pr.summary.uses === 2 && near(pr.summary.totalDiscount, 12));
  const cp = await campaignReport(ids.campaign, { from: '2026-09-16T00:00:00Z', to: '2026-09-30T23:59:59Z', inRange: '1' });
  check('campaign report in range (16–30 Sep): £7 discount + £2 cashback',
    near(cp.summary.totalDiscount, 7) && near(cp.summary.totalCashback, 2) && cp.promotions.find((x) => x.id === p1.id)?.uses === 1,
    JSON.stringify({ discount: cp.summary.totalDiscount, cashback: cp.summary.totalCashback }));

  // Route + permission through the running API (skipped when it is not up).
  let redis;
  try {
    redis = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
    await redis.connect();
    const dv = `spend-report-${RUN}`;
    const token = signAdminAccessToken({ id: 1, email: 'spend-report@local', dvToken: dv, zoneId: '' });
    await redis.hSet('tsh1', { [dv]: token });
    const res = await fetch(`${BASE}/admin/reports/promotions?period=custom&startDate=2026-09-01&endDate=2026-09-30&search=${encodeURIComponent(TAG)}`, { headers: { accesstoken: token } });
    const json = await res.json();
    check('GET /admin/reports/promotions', res.status === 200 && json.data?.total === 3 && near(json.data?.summary?.cost, 27), `status=${res.status}`);
    const res2 = await fetch(`${BASE}/admin/reports/campaigns?period=all&search=${encodeURIComponent(TAG)}`, { headers: { accesstoken: token } });
    const json2 = await res2.json();
    check('GET /admin/reports/campaigns', res2.status === 200 && json2.data?.total === 1, `status=${res2.status}`);
    await redis.hDel('tsh1', dv);
  } catch (e) {
    console.log(`SKIP API checks — ${e.message}`);
  } finally {
    await redis?.quit().catch(() => {});
  }
}

main()
  .catch((e) => { console.error(e); results.push(false); })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup failed', e));
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} passed`);
    await sequelize.close();
    process.exit(passed === results.length ? 0 : 1);
  });

'use strict';

/**
 * End-to-end checks for the promotions APIs + redemption ledger against a LOCAL stack.
 *
 *   npm run test:promotions-api
 *
 * Needs: backend running on PROMO_TEST_BASE_URL (default http://localhost:3010), local MySQL + Redis,
 * NODE_ENV=development. Creates local test sessions for existing users (PROMO_TEST_ADMIN_ID=1,
 * PROMO_TEST_STAFF_ID=33 zone staff with the promotion feature, PROMO_TEST_CUSTOMER_IDS=2,3) and test
 * rows named "QA-PROMO-IT …", which it deletes again at the end.
 */

require('dotenv').config();
const assert = require('assert');
const jwt = require('jsonwebtoken');
const { createClient } = require('redis');
const { Op } = require('sequelize');
const models = require('../models');
const { signAdminAccessToken } = require('../utils/adminJwt');
const ledger = require('../services/promotions/redemptionService');

const BASE = process.env.PROMO_TEST_BASE_URL || 'http://localhost:3010';
const ADMIN_ID = Number(process.env.PROMO_TEST_ADMIN_ID || 1);
const STAFF_ID = Number(process.env.PROMO_TEST_STAFF_ID || 33);
const [CUST_ID, CUST2_ID] = String(process.env.PROMO_TEST_CUSTOMER_IDS || '2,3').split(',').map(Number);
const PREFIX = 'QA-PROMO-IT';
const CODE_PREFIX = `QAIT${Date.now() % 100000}`;

const results = [];
function check(area, name, ok, detail = '') {
  results.push({ area, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${area}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function assertLocal() {
  assert.strictEqual(process.env.NODE_ENV, 'development', 'NODE_ENV must be development');
  assert.ok(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE), 'PROMO_TEST_BASE_URL must be local');
  const host = String(models.sequelize.config.host || '');
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host), `database host ${host} is not local`);
}

async function mintSessions() {
  const r = createClient({ url: 'redis://127.0.0.1:6379' });
  await r.connect();
  const tokens = {};
  for (const [name, id, zoneId] of [['admin', ADMIN_ID, ''], ['staff', STAFF_ID, 1]]) {
    const dv = `promo-it-${name}`;
    tokens[name] = signAdminAccessToken({ id, email: `promo-it-${id}@local`, dvToken: dv, zoneId });
    await r.hSet(`tsh${id}`, { [dv]: tokens[name] });
  }
  for (const [name, id] of [['cust', CUST_ID], ['cust2', CUST2_ID]]) {
    const dv = `promo-it-${name}`;
    tokens[name] = jwt.sign({ id, dvToken: dv, userTypeId: 2 }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    await r.hSet(`id-${id}`, { [dv]: tokens[name] });
  }
  // fresh rate-limit window for the test customers
  for (const key of await r.keys('rl:promo:*')) await r.del(key);
  await r.quit();
  return tokens;
}

let T;
async function call(method, url, body, who = 'admin') {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', accesstoken: T[who] },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}
const admin = (m, u, b, who) => call(m, `/admin${u}`, b, who);
const cust = (m, u, b, who = 'cust') => call(m, `/customer${u}`, b, who);

const basket = {
  deliveryFee: 3,
  lineItems: [
    { subCategoryId: 1, categoryId: 10, serviceId: 100, price: 20, qty: 1 },
    { subCategoryId: 2, categoryId: 10, serviceId: 100, price: 20, qty: 1 },
    { subCategoryId: 3, categoryId: 11, serviceId: 101, price: 10, qty: 2 },
  ],
};
const sim = async (extra = {}) => (await admin('POST', '/promotions/simulate', { zoneId: 1, customerId: CUST_ID, basket, ...extra })).json?.data;

async function mk(body, publish = true) {
  const r = await admin('POST', '/promotions', { visibility: 'public', ...body, name: `${PREFIX} ${body.name || body.benefitType}` });
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.json)}`);
  if (!publish) return r.json.data;
  const p = await admin('POST', `/promotions/${r.json.data.id}/publish`, {});
  if (p.status !== 200) throw new Error(`publish failed ${JSON.stringify(p.json)}`);
  return p.json.data;
}
async function archiveTestPromotions() {
  const rows = await models.promotion.findAll({ where: { name: { [Op.like]: `${PREFIX}%` }, status: { [Op.ne]: 'archived' } } });
  for (const p of rows) await admin('POST', `/promotions/${p.id}/archive`, {});
}

async function cleanup() {
  const ids = (await models.promotion.findAll({ where: { name: { [Op.like]: `${PREFIX}%` } }, attributes: ['id'] })).map((p) => p.id);
  if (ids.length) {
    await models.orderAdjustment.destroy({ where: { promotionId: ids } });
    await models.promotionRedemption.destroy({ where: { promotionId: ids } });
    await models.couponCode.destroy({ where: { promotionId: ids } });
    await models.promotionCondition.destroy({ where: { promotionId: ids } });
    await models.promotionZoneOverride.destroy({ where: { promotionId: ids } });
    await models.promotionVersion.destroy({ where: { promotionId: ids } });
    await models.promotionAuditLog.destroy({ where: { entityType: 'promotion', entityId: ids } });
    await models.promotion.destroy({ where: { id: ids } });
  }
  await models.coupon.destroy({ where: { description: { [Op.like]: `${PREFIX}%` } } });
  const campIds = (await models.campaign.findAll({ where: { name: { [Op.like]: `${PREFIX}%` } }, attributes: ['id'] })).map((c) => c.id);
  if (campIds.length) {
    await models.promotionAuditLog.destroy({ where: { entityType: 'campaign', entityId: campIds } });
    await models.campaign.destroy({ where: { id: campIds } });
  }
}

async function main() {
  assertLocal();
  T = await mintSessions();
  await cleanup();
  const others = await models.promotion.count({ where: { status: { [Op.in]: ['active', 'scheduled'] }, name: { [Op.notLike]: `${PREFIX}%` } } });
  assert.strictEqual(others, 0, 'other live promotions exist in this DB — results would be unreliable');

  // ── Permissions ──
  check('auth', 'super admin lists promotions', (await admin('GET', '/promotions')).status === 200);
  check('auth', 'zone staff with promotion permission lists promotions', (await admin('GET', '/promotions', null, 'staff')).status === 200);
  check('auth', 'zone staff can open campaigns', (await admin('GET', '/campaigns', null, 'staff')).status === 200);
  check('auth', 'customer token rejected on admin API', (await admin('GET', '/promotions', null, 'cust')).status === 403);
  {
    const r = await admin('POST', '/promotions', { name: `${PREFIX} staff zone`, benefitType: 'percentage_discount', discountValue: 5, zoneScopeMode: 'all' }, 'staff');
    check('auth', 'zone staff promotion is forced to their own zone', r.status === 201 && r.json.data.zoneScopeMode === 'selected' && JSON.stringify(r.json.data.zoneIds) === '[1]', JSON.stringify(r.json?.data?.zoneIds));
    const other = await mk({ name: 'platform only', benefitType: 'percentage_discount', discountValue: 5, zoneScopeMode: 'selected', zoneIds: [2] }, false);
    check('auth', "zone staff cannot read another zone's promotion", (await admin('GET', `/promotions/${other.id}`, null, 'staff')).status === 404);
  }

  // ── Campaigns ──
  let campaignId;
  {
    const c = await admin('POST', '/campaigns', { name: `${PREFIX} Campaign`, budgetMinor: 1000, startDate: '', endDate: '' });
    campaignId = c.json?.data?.id;
    check('campaign', 'create with empty dates', c.status === 201);
    check('campaign', 'update with empty dates', (await admin('PUT', `/campaigns/${campaignId}`, { startDate: '', endDate: '' })).status === 200);
    check('campaign', 'invalid status → 400', (await admin('PUT', `/campaigns/${campaignId}`, { status: 'bogus' })).status === 400);
    const list = await admin('GET', '/campaigns?limit=200');
    check('campaign', 'list count matches rows', list.json.count === list.json.rows.length);
  }

  // ── Promotion CRUD ──
  let p1;
  {
    const r = await admin('POST', '/promotions', {
      name: `${PREFIX} Basic`, campaignId, benefitType: 'percentage_discount', discountValue: 10, perCustomerLimit: null,
      conditions: [{ conditionType: 'MINIMUM_SUBTOTAL', operator: 'gte', value: 20 }],
      couponCodes: [{ code: `${CODE_PREFIX}A`, codeType: 'customer_bound', customerId: CUST_ID, usageLimit: 3 }],
    });
    p1 = r.json?.data;
    check('promotion', 'create draft with condition + coupon', r.status === 201 && p1.conditions.length === 1 && p1.couponCodes.length === 1);
    check('promotion', 'perCustomerLimit null kept (unlimited)', p1.perCustomerLimit === null);
    check('promotion', 'duplicate codes → 400', (await admin('POST', '/promotions', { name: `${PREFIX} d`, benefitType: 'percentage_discount', discountValue: 5, couponCodes: [{ code: 'QAITDUP' }, { code: 'qaitdup' }] })).status === 400);
    check('promotion', '150% category discount → 400', (await admin('POST', '/promotions', { name: `${PREFIX} c`, benefitType: 'category_discount', discountValue: 150, targetIds: [10] })).status === 400);
    check('promotion', 'end before start → 400', (await admin('POST', '/promotions', { name: `${PREFIX} e`, benefitType: 'percentage_discount', discountValue: 5, startDate: '2026-12-31', endDate: '2026-01-01' })).status === 400);
    check('promotion', 'buy_x_get_y → 400 (not supported yet)', (await admin('POST', '/promotions', { name: `${PREFIX} b`, benefitType: 'buy_x_get_y', discountValue: 1 })).status === 400);
    check('promotion', 'PAYMENT_METHOD = true → 400', (await admin('POST', '/promotions', { name: `${PREFIX} pm`, benefitType: 'percentage_discount', discountValue: 5, conditions: [{ conditionType: 'PAYMENT_METHOD', operator: 'equals', value: true }] })).status === 400);

    const upd = await admin('PUT', `/promotions/${p1.id}`, { name: `${PREFIX} Basic edited`, startDate: '', endDate: '', campaignId: null, couponCodes: [{ code: `${CODE_PREFIX}A` }, { code: `${CODE_PREFIX}B` }] });
    const d = (await admin('GET', `/promotions/${p1.id}`)).json.data;
    check('promotion', 'edit without conditions keeps them', d.conditions.length === 1);
    check('promotion', 'edit with empty dates succeeds', upd.status === 200, `${upd.status} ${upd.json?.message || ''}`);
    check('promotion', 'campaignId change saved', d.campaignId === null);
    const a = d.couponCodes.find((c) => c.code === `${CODE_PREFIX}A`);
    check('promotion', 'coupon added in edit is saved', d.couponCodes.some((c) => c.code === `${CODE_PREFIX}B`));
    check('promotion', 're-sent coupon keeps its customer + limit', a && a.customerId === CUST_ID && a.usageLimit === 3, JSON.stringify(a));
    const list = await admin('GET', '/promotions?limit=200');
    check('promotion', 'list count matches rows', list.json.count === list.json.rows.length);

    // A code may live in only one system: Promotions (coupon_codes) or Coupons (Legacy) (coupons).
    const legacyBody = { description: `${PREFIX} legacy`, discountType: 'percentage', discountValue: 10 };
    const lp = await admin('POST', '/addCoupon', { ...legacyBody, code: `${CODE_PREFIX}a` });
    check('codes', 'legacy coupon with a promotion code → 409', lp.status === 409 && /already used in Promotions/.test(lp.json?.message || ''), `${lp.status} ${lp.json?.message || ''}`);
    const lc = await admin('POST', '/addCoupon', { ...legacyBody, code: `${CODE_PREFIX}LEG` });
    check('codes', 'legacy coupon with a free code → 201', lc.status === 201, `${lc.status} ${lc.json?.message || ''}`);
    const legacyId = (await models.coupon.findOne({ where: { code: `${CODE_PREFIX}LEG` }, attributes: ['id'] }))?.id;
    const pe = await admin('PUT', `/promotions/${p1.id}`, { couponCodes: [{ code: `${CODE_PREFIX}A` }, { code: `${CODE_PREFIX}B` }, { code: `${CODE_PREFIX}leg` }] });
    check('codes', 'promotion edit adding a legacy code → 400', pe.status === 400 && /already used in Coupons \(Legacy\)/.test(pe.json?.message || ''), `${pe.status} ${pe.json?.message || ''}`);
    const pc = await admin('POST', '/promotions', { name: `${PREFIX} legacy clash`, benefitType: 'percentage_discount', discountValue: 5, couponCodes: [{ code: `${CODE_PREFIX}LEG` }] });
    check('codes', 'promotion create with a legacy code → 400', pc.status === 400, `${pc.status} ${pc.json?.message || ''}`);
    const pa = await admin('POST', `/promotions/${p1.id}/coupons`, { code: `${CODE_PREFIX}LEG` });
    check('codes', 'add-coupon endpoint with a legacy code → 400', pa.status === 400, `${pa.status} ${pa.json?.message || ''}`);
    const lr = await admin('PUT', `/updateCoupon/${legacyId}`, { code: `${CODE_PREFIX}B` });
    check('codes', 'legacy rename to a promotion code → 409', lr.status === 409, `${lr.status} ${lr.json?.message || ''}`);
    const ls = await admin('PUT', `/updateCoupon/${legacyId}`, { code: `${CODE_PREFIX}LEG`, description: `${PREFIX} legacy edited` });
    check('codes', 'legacy edit keeping its own code → 200', ls.status === 200, `${ls.status} ${ls.json?.message || ''}`);
    const ps = await admin('PUT', `/promotions/${p1.id}`, { couponCodes: [{ code: `${CODE_PREFIX}A` }, { code: `${CODE_PREFIX}B` }] });
    check('codes', 'promotion edit keeping its own codes → 200', ps.status === 200, `${ps.status} ${ps.json?.message || ''}`);
  }

  // ── Lifecycle ──
  {
    const pub = await admin('POST', `/promotions/${p1.id}/publish`, {});
    check('lifecycle', 'publish → active + version', pub.json?.data?.status === 'active' && pub.json.data.currentVersionId);
    const snap = pub.json.data.versions[0].configSnapshot;
    check('lifecycle', 'version snapshot is complete', snap.conditions.length === 1 && 'maxSubtotal' in snap && 'recurringStartTime' in snap && snap.couponCodes.length === 2);
    check('lifecycle', 'edit active → 400', (await admin('PUT', `/promotions/${p1.id}`, { discountValue: 20 })).status === 400);
    check('lifecycle', 'pause', (await admin('POST', `/promotions/${p1.id}/pause`, {})).json?.data?.status === 'paused');
    await admin('POST', `/promotions/${p1.id}/publish`, {});
    check('lifecycle', 're-publish → version 2', (await admin('GET', `/promotions/${p1.id}`)).json.data.versions.length === 2);

    const future = await mk({ name: 'future', benefitType: 'percentage_discount', discountValue: 5, startDate: '2027-06-01T00:00:00Z' });
    check('lifecycle', 'future start → scheduled', future.status === 'scheduled');
    const past = await mk({ name: 'past', benefitType: 'percentage_discount', discountValue: 5, startDate: '2025-01-01', endDate: '2025-02-01' }, false);
    check('lifecycle', 'already ended → publish 400', (await admin('POST', `/promotions/${past.id}/publish`, {})).status === 400);
    const draft = await mk({ name: 'bypass', benefitType: 'percentage_discount', discountValue: 5 }, false);
    check('lifecycle', '/status cannot set active', (await admin('POST', `/promotions/${draft.id}/status`, { status: 'active' })).status === 400);
    check('lifecycle', 'draft → pending_approval via /status', (await admin('POST', `/promotions/${draft.id}/status`, { status: 'pending_approval' })).json?.data?.status === 'pending_approval');
    const arch = await admin('POST', `/promotions/${draft.id}/archive`, {});
    check('lifecycle', 'archive, then archive again → 400', arch.status === 200 && (await admin('POST', `/promotions/${draft.id}/archive`, {})).status === 400);
    const clone = await admin('POST', `/promotions/${p1.id}/clone`, {});
    check('lifecycle', 'clone keeps unlimited per-customer limit', clone.status === 201 && clone.json.data.perCustomerLimit === null && clone.json.data.status === 'draft');

    // Lifecycle job: scheduled → active, active → expired
    const { runPromotionLifecycle } = require('../services/promotions/promotionJobs');
    await models.promotion.update({ startDate: new Date(Date.now() - 1000) }, { where: { id: future.id } });
    const shortLived = await mk({ name: 'short', benefitType: 'percentage_discount', discountValue: 5 });
    await models.promotion.update({ endDate: new Date(Date.now() - 1000) }, { where: { id: shortLived.id } });
    await runPromotionLifecycle();
    check('lifecycle', 'job activates scheduled promotion', (await models.promotion.findByPk(future.id)).status === 'active');
    check('lifecycle', 'job expires ended promotion', (await models.promotion.findByPk(shortLived.id)).status === 'expired');
  }
  await archiveTestPromotions();

  // ── Money (admin simulate, real DB) ──
  const money = async (name, promos, ctx, assertFn) => {
    for (const p of promos) await mk(p);
    const s = await sim(ctx);
    const [ok, detail] = assertFn(s);
    check('money', name, ok, detail);
    await archiveTestPromotions();
  };
  await money('basket_discount £50 (amount) on £60 → £50', [{ benefitType: 'basket_discount', discountMode: 'amount', discountValue: 50 }], {}, (s) => [s.totalSaving === 50, `£${s.totalSaving}`]);
  await money('cap £5 caps the whole promotion', [{ benefitType: 'category_discount', discountValue: 50, maxDiscountCap: 5, targetIds: [10] }], {}, (s) => [s.totalSaving === 5, `£${s.totalSaving}`]);
  await money('minSubtotal £100 blocks £60 basket (+ near-eligible message)', [{ name: 'min100', benefitType: 'percentage_discount', discountValue: 10, minSubtotal: 100 }], {}, (s) => [s.totalSaving === 0 && s.nearEligible.length === 1, s.nearEligible[0]?.message]);
  await money('first_order_discount does not apply to a returning customer', [{ benefitType: 'first_order_discount', discountValue: 20 }], { customerId: CUST_ID }, (s) => [s.context.customer.orderCount === 0 ? s.totalSaving > 0 : s.totalSaving === 0, `orders=${s.context.customer.orderCount} saving=£${s.totalSaving}`]);
  await money('item_discount targeting a category', [{ benefitType: 'item_discount', discountValue: 50, targetType: 'category', targetIds: [10] }], {}, (s) => [s.totalSaving === 20, `£${s.totalSaving}`]);
  await money('stacked promos never exceed the subtotal', [
    { name: 'cat80', benefitType: 'category_discount', discountValue: 80, targetIds: [10] },
    { name: 'svc80', benefitType: 'service_discount', discountValue: 80, targetIds: [100] },
    { name: 'basket50', benefitType: 'percentage_discount', discountValue: 50 },
  ], {}, (s) => [s.totalSaving === 46 && s.rejected.some((r) => r.promotionName.includes('svc80')), `£${s.totalSaving}`]);
  await money('free delivery waives the delivery fee only', [{ benefitType: 'free_delivery' }], {}, (s) => [s.deliverySaving === 3 && s.finalSubtotal === 60, `delivery £${s.deliverySaving}`]);
  await money('weekend promo honours zone-local clock (admin pinned Saturday)', [{ name: 'weekend', benefitType: 'percentage_discount', discountValue: 25, conditions: [{ conditionType: 'SCHEDULE', operator: 'between', value: { days: [0, 6] } }] }], { currentTime: '2026-10-10T12:00:00Z' }, (s) => [s.totalSaving === 15, `£${s.totalSaving}`]);
  await money('recurring overnight window 22:00–02:00 matches 23:30 London', [{ name: 'night', benefitType: 'percentage_discount', discountValue: 10, recurringStartTime: '22:00', recurringEndTime: '02:00' }], { currentTime: '2026-10-07T22:30:00Z' }, (s) => [s.totalSaving === 6, `£${s.totalSaving}`]);
  await money('promotion in an active campaign applies', [{ name: 'in campaign', benefitType: 'percentage_discount', discountValue: 10, campaignId }], {}, (s) => [s.totalSaving === 6, `£${s.totalSaving}`]);
  {
    await mk({ name: 'campaign gate', benefitType: 'percentage_discount', discountValue: 10, campaignId });
    await admin('PUT', `/campaigns/${campaignId}`, { status: 'paused' });
    const s = await sim();
    check('money', 'paused campaign switches its promotions off', s.totalSaving === 0, `£${s.totalSaving}`);
    await admin('PUT', `/campaigns/${campaignId}`, { status: 'active' });
    await archiveTestPromotions();
  }

  // ── Customer endpoints ──
  {
    await mk({ name: 'targeted returning', benefitType: 'percentage_discount', discountValue: 30, visibility: 'targeted', conditions: [{ conditionType: 'CUSTOMER_TYPE', operator: 'in', value: ['inactive'] }] });
    await mk({ name: 'HIDDEN staff', benefitType: 'percentage_discount', discountValue: 90, visibility: 'hidden', conditions: [{ conditionType: 'ORDER_COUNT', operator: 'gte', value: 100000 }] });
    await mk({ name: 'public 10', benefitType: 'percentage_discount', discountValue: 10, minSubtotal: 5 });
    // A weekday that is not today in London; the client then claims it is that day
    const { localClock } = require('../services/promotions/promotionTime');
    const otherDay = (localClock(new Date(), 'Europe/London').day + 3) % 7;
    const claimed = new Date(Date.now() + 3 * 86400000).toISOString();
    await mk({ name: 'weekend only', benefitType: 'percentage_discount', discountValue: 25, conditions: [{ conditionType: 'SCHEDULE', operator: 'between', value: { days: [otherDay] } }] });

    const offers = await cust('GET', '/promotions/offers?zoneId=1');
    const names = (offers.json?.data || []).map((o) => o.name);
    check('customer', 'offers respond with public offers', offers.status === 200 && names.some((n) => n.includes('public 10')), names.join(' | '));
    check('customer', 'targeted offer hidden from customers who do not match', !names.some((n) => n.includes('targeted returning')));

    const items = [{ subCategoryId: 1, qty: 2 }];
    const ev = await cust('POST', '/promotions/evaluate', { zoneId: 1, items, customer: { id: 999, segments: ['vip'] }, currentTime: claimed, basket: { subtotal: 1000 } });
    const d = ev.json?.data || {};
    check('customer', 'evaluate prices items server-side (client basket ignored)', ev.status === 200 && d.subtotal > 0 && d.subtotal < 1000, `subtotal £${d.subtotal}`);
    check('customer', 'evaluate ignores client clock (weekend promo not unlocked)', !(d.applied || []).some((a) => a.promotionName.includes('weekend only')));
    check('customer', 'evaluate does not leak hidden promotion names', !(d.rejected || []).some((r) => r.promotionName.includes('HIDDEN')));
    check('customer', 'evaluate response has no internal explainability', !('explainability' in d) && !('adjustments' in d));
    const bad = await cust('POST', '/promotions/evaluate', { zoneId: 1, items: [{ subCategoryId: 1, qty: 0 }] });
    check('customer', 'evaluate rejects qty 0 with 400', bad.status === 400);
    await archiveTestPromotions();
  }
  {
    // There is no delivery fee today; the zone service fee must not be waived as "delivery".
    await mk({ name: 'free delivery real zone', benefitType: 'free_delivery' });
    const ev = await cust('POST', '/promotions/evaluate', { zoneId: 1, items: [{ subCategoryId: 1, qty: 1 }] });
    const d = ev.json?.data || {};
    check('customer', 'free delivery saves £0 (no delivery fee; service fee untouched)', ev.status === 200 && Number(d.deliveryFee) === 0 && Number(d.totalSaving) === 0, `fee £${d.deliveryFee} saving £${d.totalSaving}`);
    await archiveTestPromotions();
  }
  {
    await mk({ name: 'draft code', benefitType: 'percentage_discount', discountValue: 50, activationType: 'coupon_required', couponCodes: [{ code: `${CODE_PREFIX}DRAFT` }] }, false);
    check('customer', 'code of a draft promotion is rejected', (await cust('POST', '/promotions/validate-code', { code: `${CODE_PREFIX}draft`, zoneId: 1 })).status === 400);
    await mk({ name: 'zone2 code', benefitType: 'percentage_discount', discountValue: 20, activationType: 'coupon_required', zoneScopeMode: 'selected', zoneIds: [2], couponCodes: [{ code: `${CODE_PREFIX}Z2` }] });
    const z = await cust('POST', '/promotions/validate-code', { code: `${CODE_PREFIX}Z2`, zoneId: 1 });
    check('customer', 'zone-2 code rejected in zone 1', z.status === 400 && z.json.code === 'WRONG_ZONE', z.json?.code);
    await mk({ name: 'bound', benefitType: 'percentage_discount', discountValue: 20, activationType: 'coupon_required', couponCodes: [{ code: `${CODE_PREFIX}BOUND`, codeType: 'customer_bound', customerId: CUST2_ID }] });
    check('customer', "another customer's bound code rejected", (await cust('POST', '/promotions/validate-code', { code: `${CODE_PREFIX}BOUND`, zoneId: 1 })).status === 400);
    const spoof = await cust('POST', '/promotions/evaluate', { zoneId: 1, items: [{ subCategoryId: 1, qty: 1 }], customer: { id: CUST2_ID }, couponCodes: [`${CODE_PREFIX}BOUND`] });
    check('customer', 'cannot use a bound code by sending customer.id', spoof.json?.data?.totalSaving === 0 && spoof.json.data.couponErrors[0]?.error === 'NOT_YOUR_CODE');
    check('customer', 'own bound code works', (await cust('POST', '/promotions/validate-code', { code: `${CODE_PREFIX}BOUND`, zoneId: 1 }, 'cust2')).status === 200);
    check('customer', 'numeric code does not crash', (await cust('POST', '/promotions/validate-code', { code: 12345, zoneId: 1 })).status === 400);
    let limited = 0;
    for (let i = 0; i < 12; i++) if ((await cust('POST', '/promotions/validate-code', { code: `NOPE${i}`, zoneId: 1 })).status === 429) limited++;
    check('customer', 'coupon brute force is rate limited', limited > 0, `${limited} of 12 attempts blocked`);
    await archiveTestPromotions();
  }

  // ── Ledger (service level, real DB) ──
  {
    const P = models.promotion;
    const live = { benefitType: 'percentage_discount', discountValue: 10, status: 'active' };
    const p = await P.create({ ...live, name: `${PREFIX} ledger limit`, globalUsageLimit: 5, perCustomerLimit: null });
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => ledger.reserveRedemption({ promotionId: p.id, customerId: 1000 + i })));
    const won = attempts.filter((a) => a.status === 'fulfilled').length;
    const errs = attempts.filter((a) => a.status === 'rejected').map((a) => a.reason.code);
    check('ledger', '20 concurrent reservations, limit 5 → exactly 5', won === 5, `${won} won`);
    check('ledger', 'losers get PROMOTION_USAGE_EXHAUSTED', errs.length === 15 && errs.every((c) => c === 'PROMOTION_USAGE_EXHAUSTED'), [...new Set(errs)].join(','));

    const p2 = await P.create({ ...live, name: `${PREFIX} ledger coupon`, perCustomerLimit: null });
    const cc = await models.couponCode.create({ promotionId: p2.id, code: `${CODE_PREFIX}L1`, usageLimit: 1, isActive: true });
    const two = await Promise.allSettled([1, 2].map((c) => ledger.reserveRedemption({ promotionId: p2.id, customerId: 2000 + c, couponCode: cc.code })));
    check('ledger', 'coupon usageLimit 1: only one concurrent reservation', two.filter((x) => x.status === 'fulfilled').length === 1);
    const exp = await models.couponCode.create({ promotionId: p2.id, code: `${CODE_PREFIX}EXP`, expiryDate: new Date('2025-01-01'), isActive: true });
    const e1 = await ledger.reserveRedemption({ promotionId: p2.id, customerId: 3001, couponCode: exp.code }).catch((e) => e);
    check('ledger', 'expired coupon cannot be reserved', e1.code === 'COUPON_EXPIRED', e1.code);
    const e2 = await ledger.reserveRedemption({ promotionId: p2.id, customerId: 3002, couponCode: 'TOTALLY-WRONG' }).catch((e) => e);
    check('ledger', 'unknown coupon cannot be reserved', e2.code === 'COUPON_INVALID', e2.code);

    const p3 = await P.create({ ...live, name: `${PREFIX} ledger per-customer`, perCustomerLimit: 1 });
    const old = await ledger.reserveRedemption({ promotionId: p3.id, customerId: 4001 });
    await models.promotionRedemption.update({ reservationExpiresAt: new Date(Date.now() - 60000) }, { where: { id: old.id } });
    const again = await ledger.reserveRedemption({ promotionId: p3.id, customerId: 4001 }).catch((e) => e);
    check('ledger', 'expired reservation does not block the customer', again.status === 'RESERVED', again.code || '');
    const dup = await ledger.reserveRedemption({ promotionId: p3.id, customerId: 4001 }).catch((e) => e);
    check('ledger', 'per-customer limit enforced', dup.code === 'PROMOTION_PER_CUSTOMER_LIMIT', dup.code);

    const camp = await models.campaign.create({ name: `${PREFIX} budget`, budgetMinor: 500, status: 'active' });
    const p4 = await P.create({ ...live, name: `${PREFIX} ledger budget`, perCustomerLimit: null, campaignId: camp.id });
    const key = `promo-it-${Date.now()}`;
    const r1 = await ledger.reserveRedemption({ promotionId: p4.id, customerId: 5001, idempotencyKey: key });
    const r2 = await ledger.reserveRedemption({ promotionId: p4.id, customerId: 5001, idempotencyKey: key });
    check('ledger', 'idempotency key returns the same reservation', r1.id === r2.id);
    await ledger.commitRedemption(r1.id, null, 5);
    await ledger.commitRedemption(r1.id, null, 5);
    check('ledger', 'commit is idempotent and consumes campaign budget once', (await camp.reload()).usedBudgetMinor === 500 && (await P.findByPk(p4.id)).globalUsedCount === 1);
    const over = await ledger.reserveRedemption({ promotionId: p4.id, customerId: 5002 }).catch((e) => e);
    check('ledger', 'exhausted campaign budget blocks reservations', over.code === 'PROMOTION_BUDGET_EXHAUSTED', over.code);
    await ledger.reverseRedemption(r1.id, 'refund');
    check('ledger', 'reverse gives the budget back', (await camp.reload()).usedBudgetMinor === 0);

    const booking = await models.booking.findOne({ attributes: ['id'], order: [['id', 'DESC']] });
    if (booking) {
      const applied = [{ promotionId: p4.id, benefitType: 'percentage_discount', adjustments: [{ lineType: 'basket', amountMinor: -500, amount: -5, label: 'x' }] }];
      await ledger.writeOrderAdjustments(booking.id, applied);
      await ledger.writeOrderAdjustments(booking.id, applied);
      const n = await models.orderAdjustment.count({ where: { bookingId: booking.id, promotionId: p4.id } });
      check('ledger', 'writeOrderAdjustments is idempotent', n === 1, `${n} rows`);
    }
    const cleaned = await ledger.cleanupExpiredReservations();
    check('ledger', 'cleanup releases expired reservations', cleaned.total >= 0);
    await models.campaign.destroy({ where: { id: camp.id } });

    // Booking holds: reservation made with a booking lives until commit/release (booking → invoice takes days).
    const openBooking = await models.booking.findOne({ where: { bookingStatusId: { [Op.notIn]: [19, 21] } }, attributes: ['id'], order: [['id', 'DESC']] });
    const closedBooking = await models.booking.findOne({ where: { bookingStatusId: [19, 21] }, attributes: ['id'], order: [['id', 'DESC']] });
    if (openBooking && closedBooking) {
      const p5 = await P.create({ ...live, name: `${PREFIX} ledger booking hold`, perCustomerLimit: null });
      const k = ledger.bookingReservationKey(openBooking.id, p5.id);
      const h = await ledger.reserveRedemption({ promotionId: p5.id, customerId: 6001, bookingId: openBooking.id, idempotencyKey: k });
      const days = (new Date(h.reservationExpiresAt) - Date.now()) / 86400000;
      check('ledger', 'booking hold saves the booking and lasts ~60 days', Number(h.bookingId) === openBooking.id && days > 59 && days <= 60, `${days.toFixed(2)} days`);
      check('ledger', 'booking hold retry returns the same row', (await ledger.reserveRedemption({ promotionId: p5.id, customerId: 6001, bookingId: openBooking.id, idempotencyKey: k })).id === h.id);
      check('ledger', 'listBookingRedemptions finds the hold', (await ledger.listBookingRedemptions(openBooking.id)).some((r) => r.id === h.id));

      // Expired hold on an open booking is extended, not lost.
      await models.promotionRedemption.update({ reservationExpiresAt: new Date(Date.now() - 60000) }, { where: { id: h.id } });
      await ledger.cleanupExpiredReservations();
      const hx = await models.promotionRedemption.findByPk(h.id);
      check('ledger', 'cleanup extends an expired hold of an open booking', hx.status === 'RESERVED' && new Date(hx.reservationExpiresAt) > new Date(), hx.status);

      // Hold on a cancelled booking is released by the safety net, even before it expires.
      const c = await ledger.reserveRedemption({ promotionId: p5.id, customerId: 6002, bookingId: closedBooking.id, idempotencyKey: ledger.bookingReservationKey(closedBooking.id, p5.id) });
      await ledger.cleanupExpiredReservations();
      check('ledger', 'cleanup releases a hold of a cancelled/refunded booking', (await models.promotionRedemption.findByPk(c.id)).status === 'RELEASED');

      // Release frees the key: the same booking can reserve again later.
      const released = await ledger.releaseBookingRedemptions(openBooking.id, 'test cancel');
      check('ledger', 'releaseBookingRedemptions releases the hold', released >= 1 && (await models.promotionRedemption.findByPk(h.id)).status === 'RELEASED');
      const again = await ledger.reserveRedemption({ promotionId: p5.id, customerId: 6001, bookingId: openBooking.id, idempotencyKey: k });
      check('ledger', 'released key can be reserved again (new row)', again.id !== h.id && again.status === 'RESERVED');
      await ledger.commitRedemption(again.id, openBooking.id, 4);
      const reversed = await ledger.reverseBookingRedemptions(openBooking.id, 'test refund');
      check('ledger', 'reverseBookingRedemptions reverses committed rows', reversed >= 1 && (await models.promotionRedemption.findByPk(again.id)).status === 'REVERSED');
      const p5row = await P.findByPk(p5.id);
      check('ledger', 'counters back to zero after release + reverse', p5row.globalReservedCount === 0 && p5row.globalUsedCount === 0, `reserved ${p5row.globalReservedCount} used ${p5row.globalUsedCount}`);
    } else {
      check('ledger', 'booking hold tests need an open and a cancelled/refunded booking in the local DB', false);
    }
  }

  // ── Booking stage (Phase 2): code check + holds at booking, behind the flag ──
  {
    const bps = require('../services/promotions/bookingPromotionService');
    const { loadCustomerFacts } = require('../services/promotions/contextBuilder');
    const flagBefore = { on: process.env.PROMOTIONS_CHECKOUT_ENABLED, zones: process.env.PROMOTIONS_CHECKOUT_ZONE_IDS };
    const open = await models.booking.findOne({ where: { bookingStatusId: { [Op.notIn]: [19, 21] }, zoneId: 1 }, attributes: ['id', 'customerId', 'createdAt'], order: [['id', 'DESC']] });
    if (!open) {
      check('booking', 'needs an open zone-1 booking in the local DB', false);
    } else {
      const code = `${CODE_PREFIX}BK`;
      const coded = await mk({ name: 'booking coded', benefitType: 'basket_discount', discountValue: 15, activationType: 'coupon_required', perCustomerLimit: null, couponCodes: [{ code }] });
      const auto = await mk({ name: 'booking auto min spend', benefitType: 'basket_discount', discountValue: 5, perCustomerLimit: null, minSubtotal: 30, conditions: [{ conditionType: 'MINIMUM_SUBTOTAL', operator: 'gte', value: 30 }] });
      const cashOnly = await mk({ name: 'booking cash only', benefitType: 'basket_discount', discountValue: 5, perCustomerLimit: null, conditions: [{ conditionType: 'PAYMENT_METHOD', operator: 'in', value: ['cash'] }] });
      const cashback = await models.promotion.create({ name: `${PREFIX} booking cashback`, benefitType: 'cashback', discountValue: 5, status: 'active', perCustomerLimit: null });
      const oncePer = await mk({ name: 'booking once per customer', benefitType: 'basket_discount', discountValue: 3, perCustomerLimit: 1 });

      delete process.env.PROMOTIONS_CHECKOUT_ENABLED;
      check('booking', 'flag off: code stays on the legacy path', (await bps.usesPromotionCode(code, 1)) === false);
      check('booking', 'flag off: nothing is held', (await bps.attachAtBooking({ bookingId: open.id, customerId: open.customerId, zoneId: 1, couponCode: code, paymentType: 'card' })).reserved.length === 0);
      const legacyApi = await cust('POST', '/applyCoupon', { code, zoneId: 1 });
      check('booking', 'flag off on the server: applyCoupon answers like today (legacy)', legacyApi.status !== 200, `${legacyApi.status} ${legacyApi.json?.message || ''}`);

      process.env.PROMOTIONS_CHECKOUT_ENABLED = 'true';
      process.env.PROMOTIONS_CHECKOUT_ZONE_IDS = '1';
      check('booking', 'flag on: code goes to Promotions', (await bps.usesPromotionCode(code.toLowerCase(), 1)) === true);
      check('booking', 'flag on but zone not allowed: legacy path', (await bps.usesPromotionCode(code, 2)) === false);
      const v = await bps.validateCodeForCheckout({ code: code.toLowerCase(), customerId: open.customerId, zoneId: 1 });
      check('booking', 'checkout answer keeps the legacy shape', v.discountAmt === 0 && v.appliesAt === 'invoice' && v.minOrderDeferred === true && v.couponData.code === code && v.couponData.discountType === 'percentage' && Number(v.couponData.discountValue) === 15, JSON.stringify({ c: v.couponData, m: v.customerMessage }));
      const bad = await bps.validateCodeForCheckout({ code: `${CODE_PREFIX}NOPE`, customerId: open.customerId, zoneId: 1 }).catch((e) => e);
      check('booking', 'unknown code → ValidationError', bad instanceof Error && /not found|inactive/i.test(bad.message), bad.message);
      const noZone = await bps.validateCodeForCheckout({ code, customerId: open.customerId, zoneId: null }).catch((e) => e);
      check('booking', 'code without a zone → ValidationError', noZone instanceof Error && /zone/i.test(noZone.message), noZone.message);

      const first = await bps.attachAtBooking({ bookingId: open.id, customerId: open.customerId, zoneId: 1, couponCode: code, paymentType: 'card' });
      const held = await models.promotionRedemption.findAll({ where: { bookingId: open.id, status: 'RESERVED', promotionId: [coded.id, auto.id, cashOnly.id, cashback.id] } });
      const heldIds = held.map((r) => r.promotionId);
      check('booking', 'coded promotion is held with its code', held.some((r) => r.promotionId === coded.id && r.couponCode === code));
      check('booking', 'automatic promotion with a spend rule is held (spend decided at invoice)', heldIds.includes(auto.id));
      check('booking', 'cash-only promotion is not held for a card booking', !heldIds.includes(cashOnly.id));
      check('booking', 'cashback is not held (no payout yet)', !heldIds.includes(cashback.id));
      const again = await bps.attachAtBooking({ bookingId: open.id, customerId: open.customerId, zoneId: 1, couponCode: code, paymentType: 'card' });
      const heldAgain = await models.promotionRedemption.count({ where: { bookingId: open.id, status: 'RESERVED', promotionId: [coded.id, auto.id] } });
      check('booking', 'attach is idempotent (retry holds nothing twice)', heldAgain === 2 && again.reserved.length === first.reserved.length, `${heldAgain} rows, ${first.reserved.length} vs ${again.reserved.length}`);
      const onceRow = await models.promotionRedemption.findOne({ where: { bookingId: open.id, promotionId: oncePer.id, status: 'RESERVED' } });
      check('booking', "a booking's own hold does not use up a 1-per-customer limit on retry", onceRow && again.reserved.includes(onceRow.id));

      const total = await models.booking.count({ where: { customerId: open.customerId, bookingStatusId: { [Op.ne]: 19 } } });
      const facts = await loadCustomerFacts(open.customerId, { excludeBookingId: open.id });
      check('booking', 'order count never includes the booking being priced', facts.orderCount === total - 1, `${facts.orderCount} of ${total}`);
      const asOf = await loadCustomerFacts(open.customerId, { excludeBookingId: open.id, before: open.createdAt });
      check('booking', 'order count "as of booking time" ignores later orders', asOf.orderCount <= facts.orderCount);

      const released = await bps.releaseForBooking(open.id, 'test');
      check('booking', 'releaseForBooking gives the holds back', released >= 3 && (await models.promotionRedemption.count({ where: { bookingId: open.id, status: 'RESERVED', promotionId: [coded.id, auto.id, oncePer.id] } })) === 0);
      await archiveTestPromotions();
    }
    if (flagBefore.on === undefined) delete process.env.PROMOTIONS_CHECKOUT_ENABLED; else process.env.PROMOTIONS_CHECKOUT_ENABLED = flagBefore.on;
    if (flagBefore.zones === undefined) delete process.env.PROMOTIONS_CHECKOUT_ZONE_IDS; else process.env.PROMOTIONS_CHECKOUT_ZONE_IDS = flagBefore.zones;
  }

  // ── Invoice stage (Phase 3): money on the real lines, cap, freeze, kill switch ──
  {
    const bps = require('../services/promotions/bookingPromotionService');
    const invoices = require('../services/Agent/invoiceManagementService');
    const flagBefore = { on: process.env.PROMOTIONS_CHECKOUT_ENABLED, zones: process.env.PROMOTIONS_CHECKOUT_ZONE_IDS };
    const BOOKING_ID = Number(process.env.PROMO_TEST_INVOICE_BOOKING_ID || 35);
    const b = await models.booking.findByPk(BOOKING_ID, { attributes: ['id', 'customerId', 'zoneId', 'paymentType', 'bookingStatusId'] });
    const billing = b && await models.billingDetails.findOne({ where: { bookingId: b.id } });
    const LINE_MARK = `${PREFIX} invoice line`;
    const activeLines = b ? await models.customerSelectedService.count({ where: { bookingId: b.id, status: true } }) : 1;
    if (!b || !billing || b.paymentType !== 'card' || activeLines > 0 || (await models.couponRedemption.count({ where: { bookingId: b.id } }))) {
      check('invoice', `needs card booking ${BOOKING_ID} with billing, no lines and no legacy coupon`, false);
    } else {
      const original = { discount: billing.discount, total: billing.total };
      const due = async () => {
        const s = await invoices.getPaymentSummaryForBooking(b.id);
        return { discount: Number(s.orderSummary.discount), due: Number(s.amountDueNow) };
      };
      const promoRows = () => models.orderAdjustment.findAll({ where: { bookingId: b.id, appliedBy: 'system', reversedAt: null } });
      const sumRows = (rows) => Math.round(rows.reduce((s, r) => s + Math.abs(Number(r.amount)), 0) * 100) / 100;
      try {
        // Lines: 2 × £10 (sub 1) + 1 × £20 (sub 2) = £40 laundry
        const lineA = await models.customerSelectedService.create({ date: new Date(), time: '10:00:00', bookingId: b.id, serviceId: 2, categoryId: 1, subCategoryId: 1, categoryPrice: 10, items: 2, status: true, serviceInstruction: LINE_MARK });
        const lineB = await models.customerSelectedService.create({ date: new Date(), time: '10:00:00', bookingId: b.id, serviceId: 2, categoryId: 1, subCategoryId: 2, categoryPrice: 20, items: 1, status: true, serviceInstruction: LINE_MARK });

        delete process.env.PROMOTIONS_CHECKOUT_ENABLED;
        const base = await due();
        check('invoice', 'baseline without promotions has no discount', base.discount === 0, `due £${base.due}`);

        process.env.PROMOTIONS_CHECKOUT_ENABLED = 'true';
        process.env.PROMOTIONS_CHECKOUT_ZONE_IDS = String(b.zoneId);
        const basket10 = await mk({ name: 'invoice basket 10%', benefitType: 'basket_discount', discountMode: 'percent', discountValue: 10, perCustomerLimit: null, zoneScopeMode: 'all' });
        const shirt1 = await mk({ name: 'invoice £1 off each sub 1', benefitType: 'item_discount', discountMode: 'amount', discountValue: 1, targetType: 'subCategory', targetIds: [1], perCustomerLimit: null, zoneScopeMode: 'all' });
        await bps.attachAtBooking({ bookingId: b.id, customerId: b.customerId, zoneId: b.zoneId, paymentType: 'card' });

        // Item first: £1 × 2 = £2; then basket 10% of £38 = £3.80 → £5.80
        const r1 = await due();
        check('invoice', 'item + basket promotions priced on the real lines (£5.80)', r1.discount === 5.8, `£${r1.discount}`);
        check('invoice', 'amount due drops by exactly the discount', Math.abs(r1.due - (base.due - 5.8)) < 0.001, `£${base.due} → £${r1.due}`);
        check('invoice', 'billingDetails.discount stores the total', Number((await billing.reload()).discount) === 5.8, String(billing.discount));
        const rows1 = await promoRows();
        check('invoice', 'order_adjustments hold the promotion lines (sum £5.80)', sumRows(rows1) === 5.8 && rows1.length >= 2, `${rows1.length} rows, £${sumRows(rows1)}`);
        await due();
        check('invoice', 're-pricing is idempotent (no double discount, no extra rows)', Number((await billing.reload()).discount) === 5.8 && (await promoRows()).length === rows1.length);

        // Agent removes the £20 line: £2 + 10% of £18 = £3.80
        await lineB.update({ status: false });
        const r2 = await due();
        check('invoice', 'removing a line re-prices (£3.80)', r2.discount === 3.8, `£${r2.discount}`);
        await lineB.update({ status: true });

        // Cap: a £100 basket promotion cannot take more than what is still payable
        const big = await mk({ name: 'invoice £100 off', benefitType: 'basket_discount', discountMode: 'amount', discountValue: 100, stackable: true, perCustomerLimit: null, zoneScopeMode: 'all' });
        await models.promotion.update({ stackable: true }, { where: { id: [basket10.id] } });
        await bps.attachAtBooking({ bookingId: b.id, customerId: b.customerId, zoneId: b.zoneId, paymentType: 'card' });
        const r3 = await due();
        check('invoice', 'discount capped at the payable balance (amount due £0, no refund)', r3.due === 0 && r3.discount === base.due, `discount £${r3.discount}, payable £${base.due}`);
        check('invoice', 'capped lines add up to the capped discount', sumRows(await promoRows()) === base.due, `£${sumRows(await promoRows())}`);
        for (const h of await models.promotionRedemption.findAll({ where: { bookingId: b.id, promotionId: big.id, status: 'RESERVED' } })) await ledger.releaseRedemption(h.id, 'test');
        await models.promotion.update({ stackable: false }, { where: { id: [basket10.id] } });
        check('invoice', 'back to £5.80 once the big hold is gone', (await due()).discount === 5.8);

        // Kill switch on an unpaid invoice: promotions off, lines removed
        delete process.env.PROMOTIONS_CHECKOUT_ENABLED;
        const off = await due();
        check('invoice', 'flag off: unpaid invoice loses the promotion discount', off.discount === 0 && (await promoRows()).length === 0 && Math.abs(off.due - base.due) < 0.001, `£${off.discount}`);
        process.env.PROMOTIONS_CHECKOUT_ENABLED = 'true';
        check('invoice', 'flag back on: discount returns', (await due()).discount === 5.8);

        // Paid: commit the holds → later edits never re-price
        const holds = await models.promotionRedemption.findAll({ where: { bookingId: b.id, status: 'RESERVED', promotionId: [basket10.id, shirt1.id] } });
        for (const h of holds) await ledger.commitRedemption(h.id, b.id, Number(h.discountAmount));
        await lineB.update({ status: false });
        const frozen = await due();
        check('invoice', 'after payment the discount is frozen (line removed, still £5.80)', frozen.discount === 5.8, `£${frozen.discount}`);
        delete process.env.PROMOTIONS_CHECKOUT_ENABLED;
        check('invoice', 'after payment the kill switch does not remove it', (await due()).discount === 5.8);
        check('invoice', 'commit recorded the per-promotion amounts', holds.map((h) => Number(h.discountAmount)).sort().join(',') === '2,3.8', holds.map((h) => h.discountAmount).join(','));
        await lineA.destroy();
        await lineB.destroy();
      } finally {
        process.env.PROMOTIONS_CHECKOUT_ENABLED = 'true';
        await ledger.reverseBookingRedemptions(b.id, 'test cleanup').catch(() => {});
        await ledger.releaseBookingRedemptions(b.id, 'test cleanup').catch(() => {});
        await models.orderAdjustment.destroy({ where: { bookingId: b.id, appliedBy: 'system' } });
        await models.customerSelectedService.destroy({ where: { bookingId: b.id, serviceInstruction: LINE_MARK } });
        await models.billingDetails.update(original, { where: { bookingId: b.id } });
        await archiveTestPromotions();
      }
    }
    if (flagBefore.on === undefined) delete process.env.PROMOTIONS_CHECKOUT_ENABLED; else process.env.PROMOTIONS_CHECKOUT_ENABLED = flagBefore.on;
    if (flagBefore.zones === undefined) delete process.env.PROMOTIONS_CHECKOUT_ZONE_IDS; else process.env.PROMOTIONS_CHECKOUT_ZONE_IDS = flagBefore.zones;
  }

  // ── Payment and lifecycle (Phase 4): settle on payment, reverse on refund, job safety net ──
  {
    const bps = require('../services/promotions/bookingPromotionService');
    const invoices = require('../services/Agent/invoiceManagementService');
    const flagBefore = { on: process.env.PROMOTIONS_CHECKOUT_ENABLED, zones: process.env.PROMOTIONS_CHECKOUT_ZONE_IDS };
    const BOOKING_ID = Number(process.env.PROMO_TEST_INVOICE_BOOKING_ID || 35);
    const b = await models.booking.findByPk(BOOKING_ID, { attributes: ['id', 'customerId', 'zoneId', 'paymentType'] });
    const billing = b && await models.billingDetails.findOne({ where: { bookingId: b.id } });
    const LINE_MARK = `${PREFIX} invoice line`;
    if (!b || !billing) {
      check('payment', `needs booking ${BOOKING_ID} with billing`, false);
    } else {
      const original = { discount: billing.discount, total: billing.total, paymentStatus: billing.paymentStatus };
      const status = async (promotionId) => (await models.promotionRedemption.findOne({ where: { bookingId: b.id, promotionId }, order: [['id', 'DESC']] }))?.status;
      process.env.PROMOTIONS_CHECKOUT_ENABLED = 'true';
      process.env.PROMOTIONS_CHECKOUT_ZONE_IDS = String(b.zoneId);
      const camp = await models.campaign.create({ name: `${PREFIX} payment budget`, budgetMinor: 100000, status: 'active' });
      try {
        await models.customerSelectedService.create({ date: new Date(), time: '10:00:00', bookingId: b.id, serviceId: 2, categoryId: 1, subCategoryId: 1, categoryPrice: 20, items: 2, status: true, serviceInstruction: LINE_MARK });
        const applies = await mk({ name: 'payment basket 10%', benefitType: 'basket_discount', discountMode: 'percent', discountValue: 10, perCustomerLimit: null, campaignId: camp.id });
        const misses = await mk({ name: 'payment needs £1000', benefitType: 'basket_discount', discountMode: 'amount', discountValue: 5, perCustomerLimit: null, minSubtotal: 1000 });
        await bps.attachAtBooking({ bookingId: b.id, customerId: b.customerId, zoneId: b.zoneId, paymentType: b.paymentType });
        await invoices.getPaymentSummaryForBooking(b.id); // the pricing the charge is computed from: £40 → 10% = £4

        const s1 = await bps.settleForBooking(b.id);
        check('payment', 'paid: the applied promotion is committed, the one that missed is released', (await status(applies.id)) === 'COMMITTED' && (await status(misses.id)) === 'RELEASED', JSON.stringify(s1));
        const committed = await models.promotionRedemption.findOne({ where: { bookingId: b.id, promotionId: applies.id, status: 'COMMITTED' } });
        check('payment', 'committed with the invoice amount (£4)', Number(committed.discountAmount) === 4, String(committed.discountAmount));
        check('payment', 'campaign budget spent by the committed amount (£4)', (await camp.reload()).usedBudgetMinor === 400, String(camp.usedBudgetMinor));
        check('payment', 'usage counted once', (await models.promotion.findByPk(applies.id)).globalUsedCount === 1);
        const s2 = await bps.settleForBooking(b.id);
        check('payment', 'settle is idempotent', s2.committed === 0 && s2.released === 0 && (await camp.reload()).usedBudgetMinor === 400);

        await bps.reverseForBooking(b.id, 'test full refund');
        check('payment', 'full refund reverses: budget and usage come back', (await status(applies.id)) === 'REVERSED' && (await camp.reload()).usedBudgetMinor === 0 && (await models.promotion.findByPk(applies.id)).globalUsedCount === 0);

        // Safety net: a Paid path that did not call settle is caught by the job
        // (a refunded booking never re-holds the same promotion: its key stays with the reversed row)
        check('payment', 'a reversed promotion is not held again on the same booking', (await bps.attachAtBooking({ bookingId: b.id, customerId: b.customerId, zoneId: b.zoneId, paymentType: b.paymentType })) && (await status(applies.id)) === 'REVERSED');
        await ledger.releaseBookingRedemptions(b.id, 'test');
        await models.orderAdjustment.destroy({ where: { bookingId: b.id, appliedBy: 'system' } });
        await models.promotion.update({ status: 'archived' }, { where: { id: [applies.id, misses.id] } });
        const later = await mk({ name: 'payment safety net 5%', benefitType: 'basket_discount', discountMode: 'percent', discountValue: 5, perCustomerLimit: null });
        await bps.attachAtBooking({ bookingId: b.id, customerId: b.customerId, zoneId: b.zoneId, paymentType: b.paymentType });
        await invoices.getPaymentSummaryForBooking(b.id);
        await models.billingDetails.update({ paymentStatus: 'Paid' }, { where: { bookingId: b.id } });
        const net = await bps.settleClosedBookings();
        check('payment', 'job safety net settles a paid booking it was not told about', (await status(later.id)) === 'COMMITTED' && net.settled >= 1, JSON.stringify(net));
      } finally {
        await ledger.reverseBookingRedemptions(b.id, 'test cleanup').catch(() => {});
        await ledger.releaseBookingRedemptions(b.id, 'test cleanup').catch(() => {});
        await models.orderAdjustment.destroy({ where: { bookingId: b.id, appliedBy: 'system' } });
        await models.customerSelectedService.destroy({ where: { bookingId: b.id, serviceInstruction: LINE_MARK } });
        await models.billingDetails.update(original, { where: { bookingId: b.id } });
        await archiveTestPromotions();
        await models.promotion.update({ campaignId: null }, { where: { campaignId: camp.id } });
        await models.campaign.destroy({ where: { id: camp.id } });
      }
    }
    if (flagBefore.on === undefined) delete process.env.PROMOTIONS_CHECKOUT_ENABLED; else process.env.PROMOTIONS_CHECKOUT_ENABLED = flagBefore.on;
    if (flagBefore.zones === undefined) delete process.env.PROMOTIONS_CHECKOUT_ZONE_IDS; else process.env.PROMOTIONS_CHECKOUT_ZONE_IDS = flagBefore.zones;
  }

  // ── Admin reports and order promotions (Phase 5) ──
  {
    const camp = await models.campaign.create({ name: `${PREFIX} report campaign`, budgetMinor: 5000, status: 'active' });
    try {
      const promo = await mk({ name: 'report zone 1', benefitType: 'basket_discount', discountValue: 10, perCustomerLimit: null, zoneScopeMode: 'selected', zoneIds: [1], campaignId: camp.id, activationType: 'coupon_required', couponCodes: [{ code: `${CODE_PREFIX}RPT` }] });
      const paid = async (customerId, zoneId, amount) => {
        const r = await ledger.reserveRedemption({ promotionId: promo.id, customerId, zoneId, couponCode: `${CODE_PREFIX}RPT` });
        await ledger.commitRedemption(r.id, null, amount);
        return r;
      };
      await paid(7001, 1, 4);
      await paid(7002, 1, 6);
      await paid(7002, 2, 5); // a zone-2 row (only possible via direct ledger use; proves staff filtering)
      const refunded = await paid(7003, 1, 3);
      await ledger.reverseRedemption(refunded.id, 'test refund');

      const rep = (await admin('GET', `/promotions/${promo.id}/analytics`)).json?.data?.report;
      check('report', 'promotion report: paid uses, total, customers (refund excluded)', rep && rep.summary.uses === 3 && rep.summary.totalDiscount === 15 && rep.summary.uniqueCustomers === 2 && rep.summary.refunded === 1 && rep.summary.refundedDiscount === 3, JSON.stringify(rep?.summary));
      check('report', 'promotion report: by zone and by code', rep && rep.byZone.length === 2 && rep.byZone[0].discount === 10 && rep.byCode[0]?.code === `${CODE_PREFIX}RPT` && rep.byCode[0].uses === 3, JSON.stringify(rep?.byZone));
      check('report', 'promotion report: 30-day daily series with today filled', rep && rep.byDay.length >= 30 && rep.byDay[rep.byDay.length - 1].uses === 3, `${rep?.byDay?.length} days`);
      check('report', 'promotion report: recent uses listed', rep && rep.recent.length === 3);
      const staffRep = (await admin('GET', `/promotions/${promo.id}/analytics`, null, 'staff')).json?.data?.report;
      check('report', 'zone staff see only their zone in the report', staffRep && staffRep.summary.uses === 2 && staffRep.summary.totalDiscount === 10 && staffRep.byZone.every((z) => z.zoneId === 1), JSON.stringify(staffRep?.summary));

      const cr = (await admin('GET', `/campaigns/${camp.id}/report`)).json?.data;
      check('report', 'campaign report: budget £50, spent £15, remaining £35', cr && cr.budget.budget === 50 && cr.budget.spent === 15 && cr.budget.remaining === 35 && cr.budget.percentUsed === 30, JSON.stringify(cr?.budget));
      check('report', 'campaign report: per-promotion share', cr && cr.promotions.length === 1 && cr.promotions[0].uses === 3 && cr.promotions[0].discount === 15);

      // Order promotions: view + remove from an unpaid order; a paid one cannot lose it
      const ord = await models.booking.findOne({ where: { zoneId: 1, bookingStatusId: { [Op.notIn]: [19, 21] } }, attributes: ['id'], order: [['id', 'DESC']] });
      const other = await models.booking.findOne({ where: { zoneId: { [Op.ne]: 1 } }, attributes: ['id'] });
      const auto = await mk({ name: 'order remove test', benefitType: 'basket_discount', discountValue: 5, perCustomerLimit: null });
      const hold = await ledger.reserveRedemption({ promotionId: auto.id, customerId: 7100, zoneId: 1, bookingId: ord.id, idempotencyKey: ledger.bookingReservationKey(ord.id, auto.id) });
      const view = (await admin('GET', `/orderPromotions/${ord.id}`)).json?.data;
      check('report', 'order promotions shows the hold in the ledger', view && view.ledger.some((l) => l.id === hold.id && l.status === 'RESERVED' && l.name.includes('order remove test')));
      const rm = await admin('POST', `/orderPromotions/${ord.id}/remove/${auto.id}`, { reason: 'customer asked' });
      check('report', 'admin removes a promotion from an unpaid order', rm.status === 200 && (await models.promotionRedemption.findByPk(hold.id)).status === 'RELEASED', `${rm.status} ${rm.json?.message || ''}`);
      check('report', 'removal is audited', (await models.promotionAuditLog.count({ where: { entityType: 'redemption', entityId: hold.id, action: 'removed_from_order' } })) === 1);
      check('report', 'removing again → 404', (await admin('POST', `/orderPromotions/${ord.id}/remove/${auto.id}`, {})).status === 404);
      const paidHold = await ledger.reserveRedemption({ promotionId: auto.id, customerId: 7100, zoneId: 1, bookingId: ord.id, idempotencyKey: ledger.bookingReservationKey(ord.id, auto.id) });
      await ledger.commitRedemption(paidHold.id, ord.id, 2);
      const rmPaid = await admin('POST', `/orderPromotions/${ord.id}/remove/${auto.id}`, {});
      check('report', 'paid order: removal refused (refund instead)', rmPaid.status === 400 && /refund/i.test(rmPaid.json?.message || ''), `${rmPaid.status} ${rmPaid.json?.message || ''}`);
      await ledger.reverseRedemption(paidHold.id, 'test cleanup');
      check('report', 'zone staff cannot open another zone\'s order promotions', other ? (await admin('GET', `/orderPromotions/${other.id}`, null, 'staff')).status === 404 : true);
      check('report', 'zone staff can open their own zone\'s order', (await admin('GET', `/orderPromotions/${ord.id}`, null, 'staff')).status === 200);
    } finally {
      await archiveTestPromotions();
      await models.promotion.update({ campaignId: null }, { where: { campaignId: camp.id } });
      await models.campaign.destroy({ where: { id: camp.id } });
    }
  }

  // ── Legacy off where Promotions run + customer promotion summary (Phase 6) ──
  {
    const bps = require('../services/promotions/bookingPromotionService');
    const invoices = require('../services/Agent/invoiceManagementService');
    const { resolvePrice } = require('../services/Admin/zoneCatalogService');
    const flagBefore = { on: process.env.PROMOTIONS_CHECKOUT_ENABLED, zones: process.env.PROMOTIONS_CHECKOUT_ZONE_IDS };
    const LINE_MARK = `${PREFIX} invoice line`;
    const rule = await models.serviceDiscount.create({ name: `${PREFIX} legacy 50%`, discountType: 'percentage', discountValue: 50, targetType: 'subCategory', targetIds: [1], zoneMode: 'all', isActive: true });
    const legacy = await models.coupon.create({ code: `${CODE_PREFIX}OLD`, description: `${PREFIX} legacy`, discountType: 'percentage', discountValue: 10, isActive: true });
    const b = await models.booking.findByPk(Number(process.env.PROMO_TEST_INVOICE_BOOKING_ID || 35), { attributes: ['id', 'customerId', 'zoneId', 'paymentType'] });
    const billing = b && await models.billingDetails.findOne({ where: { bookingId: b.id } });
    const original = billing && { discount: billing.discount, total: billing.total, paymentStatus: billing.paymentStatus };
    try {
      delete process.env.PROMOTIONS_CHECKOUT_ENABLED;
      const off = await resolvePrice(1, { subCategoryId: 1 });
      check('legacy', 'flag off: legacy service discount still prices the catalog', Boolean(off.appliedDiscount) && off.price < off.originalPrice, `£${off.price} (was £${off.originalPrice})`);
      check('legacy', 'flag off: a legacy code is allowed', (await bps.assertLegacyCodeAllowed(legacy.code, 1).then(() => true, () => false)));

      process.env.PROMOTIONS_CHECKOUT_ENABLED = 'true';
      process.env.PROMOTIONS_CHECKOUT_ZONE_IDS = '1';
      const on = await resolvePrice(1, { subCategoryId: 1 });
      check('legacy', 'flag on: catalog price is full (legacy service discount off)', !on.appliedDiscount && Number(on.price) === Number(off.originalPrice), `£${on.price}`);
      const other = await resolvePrice(2, { subCategoryId: 1 });
      check('legacy', 'zone not in the rollout keeps the legacy discount', Boolean(other.appliedDiscount));
      const blocked = await bps.assertLegacyCodeAllowed(legacy.code.toLowerCase(), 1).then(() => null, (e) => e);
      check('legacy', 'flag on: a legacy code is answered as invalid', blocked && blocked.statusCode === 404 && /invalid or inactive/.test(blocked.message), blocked?.message);
      check('legacy', 'flag on: a legacy code still works in a zone outside the rollout', await bps.assertLegacyCodeAllowed(legacy.code, 2).then(() => true, () => false));

      if (b && billing) {
        // Customer summary: holding → applied (per item original → after) → paid
        const shown = await mk({ name: 'summary public 10%', benefitType: 'basket_discount', discountMode: 'percent', discountValue: 10, perCustomerLimit: null });
        const hidden = await mk({ name: 'summary HIDDEN £1 item', benefitType: 'item_discount', discountMode: 'amount', discountValue: 1, targetType: 'subCategory', targetIds: [1], perCustomerLimit: null, visibility: 'hidden' });
        await bps.attachAtBooking({ bookingId: b.id, customerId: b.customerId, zoneId: b.zoneId, paymentType: b.paymentType });
        const s0 = await bps.customerPromotionSummary(b.id);
        check('summary', 'before the invoice: state "holding" with the customer message', s0.state === 'holding' && /finalises your invoice/.test(s0.message) && s0.total === 0, s0.state);
        check('summary', 'hidden promotion shown to the customer as "Special discount"', s0.promotions.some((p) => p.promotionId === hidden.id && p.name === 'Special discount') && s0.promotions.some((p) => p.promotionId === shown.id && p.name.includes('summary public')));

        await models.customerSelectedService.create({ date: new Date(), time: '10:00:00', bookingId: b.id, serviceId: 2, categoryId: 1, subCategoryId: 1, categoryPrice: 10, items: 2, status: true, serviceInstruction: LINE_MARK });
        await models.customerSelectedService.create({ date: new Date(), time: '10:00:00', bookingId: b.id, serviceId: 2, categoryId: 1, subCategoryId: 2, categoryPrice: 20, items: 1, status: true, serviceInstruction: LINE_MARK });
        await invoices.getPaymentSummaryForBooking(b.id); // agent added services → priced
        const s1 = await bps.customerPromotionSummary(b.id);
        const item1 = s1.lines.find((l) => l.itemId === 1);
        const item2 = s1.lines.find((l) => l.itemId === 2);
        // item 1: £20 − £2 (item) − 10% of £18 (£1.80) = £16.20 ; item 2: £20 − 10% (£2) = £18
        check('summary', 'after services are added: state "applied", total £5.80', s1.state === 'applied' && s1.total === 5.8, `${s1.state} £${s1.total}`);
        check('summary', 'per item: original → discount → after (item 1 £20 → £16.20)', item1 && item1.originalAmount === 20 && item1.discount === 3.8 && item1.finalAmount === 16.2, JSON.stringify(item1));
        check('summary', 'per item: item 2 £20 → £18', item2 && item2.originalAmount === 20 && item2.discount === 2 && item2.finalAmount === 18, JSON.stringify(item2));

        await bps.settleForBooking(b.id);
        const s2 = await bps.customerPromotionSummary(b.id);
        check('summary', 'after payment: state "paid"', s2.state === 'paid' && s2.total === 5.8 && s2.promotions.every((p) => p.status === 'paid'));
      }
    } finally {
      if (b) {
        await ledger.reverseBookingRedemptions(b.id, 'test cleanup').catch(() => {});
        await ledger.releaseBookingRedemptions(b.id, 'test cleanup').catch(() => {});
        await models.orderAdjustment.destroy({ where: { bookingId: b.id, appliedBy: 'system' } });
        await models.customerSelectedService.destroy({ where: { bookingId: b.id, serviceInstruction: LINE_MARK } });
        if (original) await models.billingDetails.update(original, { where: { bookingId: b.id } });
      }
      await archiveTestPromotions();
      await rule.destroy();
      await legacy.destroy();
      if (flagBefore.on === undefined) delete process.env.PROMOTIONS_CHECKOUT_ENABLED; else process.env.PROMOTIONS_CHECKOUT_ENABLED = flagBefore.on;
      if (flagBefore.zones === undefined) delete process.env.PROMOTIONS_CHECKOUT_ZONE_IDS; else process.env.PROMOTIONS_CHECKOUT_ZONE_IDS = flagBefore.zones;
    }
  }

  // ── Banners linked to a promotion (badge + visibility follow it) ──
  {
    const bannerService = require('../services/Admin/bannerService');
    const flagBefore = { on: process.env.PROMOTIONS_CHECKOUT_ENABLED, zones: process.env.PROMOTIONS_CHECKOUT_ZONE_IDS };
    try {
      const promo = await mk({ name: 'banner linked 15% cap £5', benefitType: 'basket_discount', discountMode: 'percent', discountValue: 15, maxDiscountCap: 5, perCustomerLimit: null });
      const created = await admin('POST', '/createBanner', { title: `${PREFIX} banner linked`, targetType: 'global', promotionId: promo.id });
      const linked = created.json?.data;
      check('banner', 'banner can link a promotion without its own offer fields', created.status === 201 && linked?.promotionId === promo.id && linked.offerType === 'percentage' && Number(linked.discountValue) === 15 && Number(linked.maxDiscountCap) === 5, `${created.status} ${created.json?.message || ''}`);
      const plain = await admin('POST', '/createBanner', { title: `${PREFIX} banner plain`, targetType: 'global', offerType: 'flat', discountValue: 3 });
      check('banner', 'unlinked banner still needs and keeps its own offer', plain.status === 201 && plain.json.data.promotionId === null);
      const archivedPromo = await models.promotion.create({ name: `${PREFIX} banner archived`, benefitType: 'basket_discount', discountValue: 5, status: 'archived' });
      const bad = await admin('POST', '/createBanner', { title: `${PREFIX} banner bad`, targetType: 'global', promotionId: archivedPromo.id });
      check('banner', 'linking an archived promotion → 400', bad.status === 400, `${bad.status} ${bad.json?.message || ''}`);

      const titles = async (zoneId) => (await bannerService.getActiveBannersForCustomer({ zoneId })).data.banners.map((b) => b.title);
      delete process.env.PROMOTIONS_CHECKOUT_ENABLED;
      let t = await titles(1);
      check('banner', 'flag off: linked banner hidden (its promotion would not apply), plain one shown', !t.includes(`${PREFIX} banner linked`) && t.includes(`${PREFIX} banner plain`));
      process.env.PROMOTIONS_CHECKOUT_ENABLED = 'true';
      process.env.PROMOTIONS_CHECKOUT_ZONE_IDS = '1';
      const shown = (await bannerService.getActiveBannersForCustomer({ zoneId: 1 })).data.banners.find((b) => b.title === `${PREFIX} banner linked`);
      check('banner', 'flag on + live promotion: linked banner shown with the promotion badge', shown && shown.offerType === 'percentage' && shown.discountValue === 15 && /15% OFF/.test(shown.offerLabel || ''), shown?.offerLabel);
      check('banner', 'zone outside the rollout: linked banner hidden', !(await titles(2)).includes(`${PREFIX} banner linked`));
      await admin('POST', `/promotions/${promo.id}/pause`, {});
      t = await titles(1);
      check('banner', 'promotion paused: linked banner disappears by itself', !t.includes(`${PREFIX} banner linked`));
    } finally {
      await models.banner.destroy({ where: { title: { [Op.like]: `${PREFIX}%` } } });
      await archiveTestPromotions();
      if (flagBefore.on === undefined) delete process.env.PROMOTIONS_CHECKOUT_ENABLED; else process.env.PROMOTIONS_CHECKOUT_ENABLED = flagBefore.on;
      if (flagBefore.zones === undefined) delete process.env.PROMOTIONS_CHECKOUT_ZONE_IDS; else process.env.PROMOTIONS_CHECKOUT_ZONE_IDS = flagBefore.zones;
    }
  }
}

main()
  .catch((err) => {
    console.error('SCRIPT ERROR', err);
    results.push({ ok: false });
  })
  .finally(async () => {
    try { await archiveTestPromotions(); await cleanup(); } catch (e) { console.error('cleanup failed', e.message); }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  });

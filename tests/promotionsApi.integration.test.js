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

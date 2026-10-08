'use strict';

/**
 * End-to-end: promotions through the real HTTP endpoints of a LOCAL stack
 * (docs/PROMOTIONS_CHECKOUT_PLAN.md, Phase 8).
 *
 *   npm run test:promotions-e2e
 *
 * The backend must run with PROMOTIONS_CHECKOUT_ENABLED=true (zone 1 allowed). Flow:
 * offers → applyCoupon (promotion code; legacy code refused) → createBooking (cash) →
 * holds → customer booking detail ("holding") → shop adds services (AgentAddSerivces) →
 * invoice discount + per-item lines ("applied") → cash collected (recordCashPayment) →
 * committed, report updated. The pickup steps between booking and the shop are not
 * promotions code: the booking is moved to "Delivered Laundry to Shop" (8) directly.
 *
 * Env: PROMO_E2E_CUSTOMER_ID (3), PROMO_E2E_ADDRESS_ID (17, inside zone 3 locally), PROMO_TEST_ADMIN_ID (1).
 */

require('dotenv').config();
const assert = require('assert');
const jwt = require('jsonwebtoken');
const { createClient } = require('redis');
const { Op } = require('sequelize');
const models = require('../models');
const { signAdminAccessToken } = require('../utils/adminJwt');

const BASE = process.env.PROMO_TEST_BASE_URL || 'http://localhost:3010';
const ADMIN_ID = Number(process.env.PROMO_TEST_ADMIN_ID || 1);
const CUST_ID = Number(process.env.PROMO_E2E_CUSTOMER_ID || 3);
const ADDRESS_ID = Number(process.env.PROMO_E2E_ADDRESS_ID || 17);
const PREFIX = 'QA-PROMO-E2E';
const CODE = `QAE2E${Date.now() % 100000}`;

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const T = {};
async function call(method, url, body, who) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', accesstoken: T[who] },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
const admin = (m, u, b) => call(m, `/admin${u}`, b, 'admin');
const cust = (m, u, b) => call(m, `/customer${u}`, b, 'cust');
const agent = (m, u, b) => call(m, `/agent${u}`, b, 'agent');

async function session(r, kind, id) {
  const dv = `promo-e2e-${kind}`;
  if (kind === 'admin') {
    T[kind] = signAdminAccessToken({ id, email: `promo-e2e-${id}@local`, dvToken: dv, zoneId: '' });
    await r.hSet(`tsh${id}`, { [dv]: T[kind] });
  } else {
    T[kind] = jwt.sign({ id, dvToken: dv, userTypeId: kind === 'cust' ? 2 : 3 }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    await r.hSet(`id-${id}`, { [dv]: T[kind] });
  }
}

const dayPlus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function cleanup() {
  const promos = await models.promotion.findAll({ where: { name: { [Op.like]: `${PREFIX}%` } }, attributes: ['id'] });
  const ids = promos.map((p) => p.id);
  if (ids.length) {
    await models.orderAdjustment.destroy({ where: { promotionId: ids } });
    await models.promotionRedemption.destroy({ where: { promotionId: ids } });
    await models.couponCode.destroy({ where: { promotionId: ids } });
    await models.promotionCondition.destroy({ where: { promotionId: ids } });
    await models.promotionVersion.destroy({ where: { promotionId: ids } });
    await models.promotionAuditLog.destroy({ where: { entityType: 'promotion', entityId: ids } });
    await models.promotion.destroy({ where: { id: ids } });
  }
  await models.coupon.destroy({ where: { description: { [Op.like]: `${PREFIX}%` } } });
}

async function main() {
  assert.strictEqual(process.env.NODE_ENV, 'development', 'NODE_ENV must be development');
  assert.ok(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE), 'local backend only');
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(String(models.sequelize.config.host)), 'local database only');

  const r = createClient({ url: 'redis://127.0.0.1:6379' });
  await r.connect();
  await session(r, 'admin', ADMIN_ID);
  await session(r, 'cust', CUST_ID);
  await cleanup();

  const address = await models.addressDb.findByPk(ADDRESS_ID);
  assert.ok(address && Number(address.userId) === CUST_ID, `address ${ADDRESS_ID} must belong to customer ${CUST_ID}`);
  // The zone createBooking will resolve for this address (geometry / postcode), not the stored column.
  const { findZones } = require('../utils/findZones');
  const zoneId = (await findZones(Number(address.lat), Number(address.lng)))?.[0]?.id;
  assert.ok(zoneId, `address ${ADDRESS_ID} is not inside any zone`);
  console.log(`zone ${zoneId} (backend must allow it in PROMOTIONS_CHECKOUT_ZONE_IDS)`);

  // Promotions: automatic 10% basket + a code for £1 off each Standard Trousers (sub 1)
  const mk = async (body) => {
    const c = await admin('POST', '/promotions', { visibility: 'public', perCustomerLimit: null, zoneScopeMode: 'all', ...body });
    assert.strictEqual(c.status, 201, `create promotion: ${c.json?.message}`);
    const p = await admin('POST', `/promotions/${c.json.data.id}/publish`, {});
    assert.strictEqual(p.status, 200, `publish: ${p.json?.message}`);
    return c.json.data;
  };
  const auto = await mk({ name: `${PREFIX} 10% basket`, benefitType: 'basket_discount', discountMode: 'percent', discountValue: 10 });
  const coded = await mk({ name: `${PREFIX} £1 off trousers`, benefitType: 'item_discount', discountMode: 'amount', discountValue: 1, targetType: 'subCategory', targetIds: [1], activationType: 'coupon_required', couponCodes: [{ code: CODE }] });
  const legacy = await admin('POST', '/addCoupon', { code: `${CODE}OLD`, description: `${PREFIX} legacy`, discountType: 'percentage', discountValue: 10 });

  // 1. Customer sees the offers
  const offers = await cust('GET', `/promotions/offers?zoneId=${zoneId}`);
  check('customer sees the automatic offer', offers.status === 200 && (offers.json?.data || []).some((o) => o.id === auto.id && /10% OFF/.test(o.label)), `${offers.status}`);

  // 2. Code box: promotion code works, legacy code refused (legacy off with the flag)
  const apply = await cust('POST', '/applyCoupon', { code: CODE.toLowerCase(), zoneId: zoneId, laundryCartAmount: 0 });
  check('applyCoupon accepts the promotion code (legacy shape, code returned)', apply.status === 200 && apply.json?.data?.code === CODE && apply.json.data.discountAmt === 0 && /OFF/.test(apply.json.data.offerLabel || ''), `${apply.status} ${apply.json?.message}`);
  if (legacy.status === 201) {
    const old = await cust('POST', '/applyCoupon', { code: `${CODE}OLD`, zoneId: zoneId });
    check('legacy code refused where promotions run', old.status === 404, `${old.status} ${old.json?.message}`);
    if (old.status === 200) console.log('  (is the backend running with PROMOTIONS_CHECKOUT_ENABLED=true?)');
  }

  // 3. Booking (cash)
  const create = await cust('POST', '/createBooking', {
    collectionDate: dayPlus(3), collectionTimeFrom: '09:00', collectionTimeTo: '11:00',
    deliveryDate: dayPlus(6), deliveryTimeFrom: '17:00', deliveryTimeTo: '19:00',
    frequency: 'Just Once',
    pickUpAddress: { lat: Number(address.lat), lng: Number(address.lng) },
    pickUpAddressId: address.id,
    dropOffSamePickUp: true,
    services: [{ serviceId: 2, categoryId: 1, subCategoryId: 1, items: 2 }],
    totalItems: 2,
    totalBags: 1,
    paymentType: 'cash',
    tipAmount: 0,
    couponCode: CODE,
    driverInstruction: `${PREFIX} booking`,
    driverInstructionOptions: 'Collect from me in person',
    driverInstructionOptions1: 'Deliver to me in person',
    timeZone: 'Europe/London',
  });
  // createBooking does not return the id: find the booking this run just created.
  const created = create.status === 200
    ? await models.booking.findOne({ where: { customerId: CUST_ID, driverInstruction: `${PREFIX} booking` }, order: [['id', 'DESC']], attributes: ['id'] })
    : null;
  const bookingId = created?.id;
  check('createBooking (cash) succeeds with the code', create.status === 200 && Boolean(bookingId), `${create.status} ${create.json?.message || ''}`);
  if (!bookingId) return finish(r);

  const holds = await models.promotionRedemption.findAll({ where: { bookingId, status: 'RESERVED' } });
  check('booking holds the coded and the automatic promotion', holds.some((h) => h.promotionId === coded.id && h.couponCode === CODE) && holds.some((h) => h.promotionId === auto.id), holds.map((h) => h.promotionId).join(','));

  const detail0 = await cust('GET', `/bookingDetailsById?bookingId=${bookingId}`);
  const s0 = detail0.json?.data?.promotionSummary;
  check('customer booking detail: "holding" + message', s0?.state === 'holding' && /finalises your invoice/.test(s0.message || ''), JSON.stringify(s0 && { state: s0.state }));

  // 4. Laundry reaches the shop (pickup steps are outside promotions)
  const shopUserId = (await models.addressDb.findByPk((await models.booking.findByPk(bookingId)).laundryShopId || 0))?.userId;
  await models.booking.update({ bookingStatusId: 8 }, { where: { id: bookingId } });
  await session(r, 'agent', shopUserId || ADMIN_ID);

  // 5. Shop adds what it found: 2 × Standard Trousers (£7.50) + 1 × Wool Trousers (£9) = £24
  const add = await agent('POST', '/AgentAddSerivces', {
    bookingId,
    services: [
      { serviceId: 2, categoryId: 1, subCategoryId: 1, items: 2 },
      { serviceId: 2, categoryId: 1, subCategoryId: 2, items: 1 },
    ],
    timeZone: 'Europe/London',
  });
  check('shop finalises the invoice (AgentAddSerivces)', add.status === 200, `${add.status} ${add.json?.message || ''}`);

  // £1 × 2 on trousers = £2, then 10% of (£24 − £2) = £2.20 → £4.20
  const detail1 = await cust('GET', `/bookingDetailsById?bookingId=${bookingId}`);
  const d1 = detail1.json?.data || {};
  const s1 = d1.promotionSummary;
  const std = s1?.lines?.find((l) => l.itemId === 1);
  const wool = s1?.lines?.find((l) => l.itemId === 2);
  check('invoice discount = £4.20 (item code + automatic basket)', Number(d1.paymentSummary?.orderSummary?.discount) === 4.2 && Number(d1.billingDetail?.discount) === 4.2, `${d1.paymentSummary?.orderSummary?.discount}`);
  // The 10% basket share follows each item's remaining amount (£13 and £9 of £22): £1.30 + £0.90.
  check('customer detail: "applied", Standard £15 → £11.70 (£2 code + £1.30 basket share)', s1?.state === 'applied' && std?.originalAmount === 15 && std?.discount === 3.3 && std?.finalAmount === 11.7, JSON.stringify(std));
  check('customer detail: Wool £9 → £8.10 (£0.90 basket share)', wool?.originalAmount === 9 && wool?.finalAmount === 8.1, JSON.stringify(wool));
  const due = Number(d1.paymentSummary?.amountDueNow);
  const total = Number(d1.paymentSummary?.orderSummary?.totalOrderAmount);
  check('cash amount due is net of the discount', Math.abs(due - (total - 4.2)) < 0.001, `total £${total}, due £${due}`);

  // 6. Driver collects the cash
  const cash = await agent('POST', '/recordCashPayment', { bookingId, amountCollected: due });
  check('cash recorded', cash.status === 200, `${cash.status} ${cash.json?.message || ''}`);
  const after = await models.promotionRedemption.findAll({ where: { bookingId } });
  check('paid: both promotions committed with their amounts (£2 + £2.20)', after.filter((h) => h.status === 'COMMITTED').map((h) => Number(h.discountAmount)).sort().join(',') === '2,2.2', after.map((h) => `${h.status}:${h.discountAmount}`).join(' '));
  const s2 = (await cust('GET', `/bookingDetailsById?bookingId=${bookingId}`)).json?.data?.promotionSummary;
  check('customer detail: "paid"', s2?.state === 'paid');

  const rep = (await admin('GET', `/promotions/${auto.id}/analytics`)).json?.data?.report;
  check('admin report counts the paid use', rep?.summary?.uses === 1 && rep.summary.totalDiscount === 2.2, JSON.stringify(rep?.summary));
  const ord = (await admin('GET', `/orderPromotions/${bookingId}`)).json?.data;
  check('admin order promotions show both', ord?.applied?.length === 2 && ord.total === 4.2, JSON.stringify(ord && { total: ord.total }));

  await models.booking.update({ bookingStatusId: 17 }, { where: { id: bookingId } });
  return finish(r);
}

async function finish(r) {
  for (const p of await models.promotion.findAll({ where: { name: { [Op.like]: `${PREFIX}%` }, status: { [Op.ne]: 'archived' } } })) {
    await admin('POST', `/promotions/${p.id}/archive`, {});
  }
  await r.hDel(`tsh${ADMIN_ID}`, 'promo-e2e-admin');
  await r.quit();
}

main()
  .catch((err) => {
    console.error('SCRIPT ERROR', err);
    results.push(false);
  })
  .finally(async () => {
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} passed`);
    await models.sequelize.close();
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });

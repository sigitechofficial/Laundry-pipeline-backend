'use strict';

/**
 * Positive and negative cases for promotions through the real HTTP endpoints of a LOCAL
 * stack (docs/PROMOTIONS_CHECKOUT_PLAN.md). Complements promotionsCheckout.e2e.test.js.
 *
 *   npm run test:promotions-cases
 *
 * Needs: backend with PROMOTIONS_CHECKOUT_ENABLED=true and the test zone allowed, local
 * MySQL + Redis, Stripe TEST key (card cases use Stripe test cards, no real money).
 * Creates bookings for the test customer marked "QA-PROMO-CASES" in driverInstruction.
 *
 * Env: PROMO_E2E_CUSTOMER_ID (3), PROMO_E2E_ADDRESS_ID (17), PROMO_E2E_OTHER_CUSTOMER_ID (2).
 */

require('dotenv').config();
const assert = require('assert');
const jwt = require('jsonwebtoken');
const { createClient } = require('redis');
const { Op } = require('sequelize');
const models = require('../models');
const { signAdminAccessToken } = require('../utils/adminJwt');
const ledger = require('../services/promotions/redemptionService');
const { findZones } = require('../utils/findZones');

const BASE = process.env.PROMO_TEST_BASE_URL || 'http://localhost:3010';
const ADMIN_ID = Number(process.env.PROMO_TEST_ADMIN_ID || 1);
const CUST_ID = Number(process.env.PROMO_E2E_CUSTOMER_ID || 3);
const OTHER_CUST_ID = Number(process.env.PROMO_E2E_OTHER_CUSTOMER_ID || 2);
const ADDRESS_ID = Number(process.env.PROMO_E2E_ADDRESS_ID || 17);
const PREFIX = 'QA-PROMO-CASES';
const RUN = Date.now() % 100000;

const results = [];
function check(area, name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} [${area}] ${name}${detail ? ` — ${detail}` : ''}`);
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
  return { status: res.status, json, message: json?.message || json?.error || '' };
}
const admin = (m, u, b) => call(m, `/admin${u}`, b, 'admin');
const cust = (m, u, b) => call(m, `/customer${u}`, b, 'cust');
const agent = (m, u, b) => call(m, `/agent${u}`, b, 'agent');

let redis;
async function session(kind, id) {
  const dv = `promo-cases-${kind}`;
  if (kind === 'admin') {
    T[kind] = signAdminAccessToken({ id, email: `promo-cases-${id}@local`, dvToken: dv, zoneId: '' });
    await redis.hSet(`tsh${id}`, { [dv]: T[kind] });
  } else {
    T[kind] = jwt.sign({ id, dvToken: dv, userTypeId: kind === 'agent' ? 3 : 2 }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    await redis.hSet(`id-${id}`, { [dv]: T[kind] });
  }
}

let seq = 0;
async function promo(body, { publish = true } = {}) {
  seq += 1;
  const c = await admin('POST', '/promotions', {
    visibility: 'public', perCustomerLimit: null, zoneScopeMode: 'all', benefitType: 'basket_discount', discountMode: 'percent', discountValue: 10,
    ...body,
    name: `${PREFIX} ${seq} ${body.name || ''}`.trim(),
  });
  assert.strictEqual(c.status, 201, `create promotion "${body.name}": ${c.message}`);
  if (!publish) return c.json.data;
  const p = await admin('POST', `/promotions/${c.json.data.id}/publish`, {});
  assert.strictEqual(p.status, 200, `publish "${body.name}": ${p.message}`);
  return p.json.data;
}
/** Only this test's promotions may be live, so other local promotions don't change the numbers. */
async function archiveAll() {
  for (const p of await models.promotion.findAll({ where: { name: { [Op.like]: `${PREFIX}%` }, status: { [Op.notIn]: ['archived'] } } })) {
    await admin('POST', `/promotions/${p.id}/archive`, {});
  }
}

const dayPlus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let address;
let zoneId;
const bookingCount = () => models.booking.count({ where: { customerId: CUST_ID } });

async function book(tag, { code, paymentType = 'cash', paymentMethodId, stripeCustomerId } = {}) {
  const marker = `${PREFIX} ${RUN} ${tag}`;
  const res = await cust('POST', '/createBooking', {
    collectionDate: dayPlus(3), collectionTimeFrom: '09:00', collectionTimeTo: '11:00',
    deliveryDate: dayPlus(6), deliveryTimeFrom: '17:00', deliveryTimeTo: '19:00',
    frequency: 'Just Once',
    pickUpAddress: { lat: Number(address.lat), lng: Number(address.lng) },
    pickUpAddressId: address.id,
    dropOffSamePickUp: true,
    services: [{ serviceId: 2, categoryId: 1, subCategoryId: 1, items: 2 }],
    totalItems: 2,
    totalBags: 1,
    paymentType,
    paymentMethodId,
    stripeCustomerId,
    tipAmount: 0,
    couponCode: code,
    driverInstruction: marker,
    driverInstructionOptions: 'Collect from me in person',
    driverInstructionOptions1: 'Deliver to me in person',
    timeZone: 'Europe/London',
  });
  const row = await models.booking.findOne({ where: { customerId: CUST_ID, driverInstruction: marker }, order: [['id', 'DESC']], attributes: ['id', 'bookingStatusId', 'paymentIntentId'] });
  return { ...res, booking: row };
}

/** Laundry reaches the shop, which adds what it found (Standard Trousers £7.50 each, Wool £9). */
async function shopAdds(bookingId, { standard = 2, wool = 1 } = {}) {
  await models.booking.update({ bookingStatusId: 8 }, { where: { id: bookingId } });
  const services = [];
  if (standard) services.push({ serviceId: 2, categoryId: 1, subCategoryId: 1, items: standard });
  if (wool) services.push({ serviceId: 2, categoryId: 1, subCategoryId: 2, items: wool });
  const r = await agent('POST', '/AgentAddSerivces', { bookingId, services, timeZone: 'Europe/London' });
  assert.strictEqual(r.status, 200, `AgentAddSerivces: ${r.message}`);
  const d = await cust('GET', `/bookingDetailsById?bookingId=${bookingId}`);
  return d.json?.data || {};
}
const discountOf = (detail) => Number(detail.paymentSummary?.orderSummary?.discount || 0);
async function payCash(bookingId) {
  const d = (await cust('GET', `/bookingDetailsById?bookingId=${bookingId}`)).json?.data || {};
  const r = await agent('POST', '/recordCashPayment', { bookingId, amountCollected: Number(d.paymentSummary?.amountDueNow || 0) });
  assert.strictEqual(r.status, 200, `recordCashPayment: ${r.message}`);
}
const holdOf = (bookingId, promotionId) => models.promotionRedemption.findOne({ where: { bookingId, promotionId }, order: [['id', 'DESC']] });
const apply = (code) => cust('POST', '/applyCoupon', { code, zoneId, laundryCartAmount: 0 });

async function main() {
  assert.strictEqual(process.env.NODE_ENV, 'development', 'NODE_ENV must be development');
  assert.ok(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE), 'local backend only');
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(String(models.sequelize.config.host)), 'local database only');
  assert.ok(String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_'), 'Stripe TEST key only');

  redis = createClient({ url: 'redis://127.0.0.1:6379' });
  await redis.connect();
  await session('admin', ADMIN_ID);
  await session('cust', CUST_ID);
  await session('agent', ADMIN_ID);
  for (const k of await redis.keys('rl:promo:*')) await redis.del(k);

  address = await models.addressDb.findByPk(ADDRESS_ID);
  zoneId = (await findZones(Number(address.lat), Number(address.lng)))?.[0]?.id;
  assert.ok(zoneId, 'test address must be inside a zone');
  await archiveAll();

  // ── A. Code box: negative cases (each must be refused with a clear message) ──
  {
    const r = await apply(`NOPE${RUN}`);
    check('code', 'unknown code refused', r.status === 404 && /invalid or inactive/i.test(r.message), `${r.status} ${r.message}`);

    const expired = await promo({ name: 'expired', activationType: 'coupon_required', couponCodes: [{ code: `QAC${RUN}EXP` }] });
    await models.promotion.update({ endDate: new Date(Date.now() - 86400000) }, { where: { id: expired.id } });
    const e = await apply(`QAC${RUN}EXP`);
    check('code', 'code of an ended promotion refused', e.status === 400 && /not available/i.test(e.message), `${e.status} ${e.message}`);

    await promo({ name: 'other zone', activationType: 'coupon_required', zoneScopeMode: 'selected', zoneIds: [zoneId === 1 ? 3 : 1], couponCodes: [{ code: `QAC${RUN}ZONE` }] });
    const z = await apply(`QAC${RUN}ZONE`);
    check('code', 'code for another zone refused', z.status === 400 && /not valid in your area/i.test(z.message), `${z.status} ${z.message}`);

    await promo({ name: 'bound', activationType: 'coupon_required', couponCodes: [{ code: `QAC${RUN}BOUND`, codeType: 'customer_bound', customerId: OTHER_CUST_ID }] });
    const b = await apply(`QAC${RUN}BOUND`);
    check('code', "another customer's personal code refused", b.status === 400 && /another customer/i.test(b.message), `${b.status} ${b.message}`);

    const once = await promo({ name: 'once per customer', activationType: 'coupon_required', perCustomerLimit: 1, couponCodes: [{ code: `QAC${RUN}ONCE` }] });
    const ok1 = await apply(`QAC${RUN}ONCE`);
    const used = await ledger.reserveRedemption({ promotionId: once.id, customerId: CUST_ID, couponCode: `QAC${RUN}ONCE`, zoneId });
    await ledger.commitRedemption(used.id, null, 1);
    const o = await apply(`QAC${RUN}ONCE`);
    check('code', 'code works once, then "already used"', ok1.status === 200 && o.status === 400 && /already used/i.test(o.message), `${ok1.status} then ${o.status} ${o.message}`);

    const paused = await models.campaign.create({ name: `${PREFIX} paused campaign`, status: 'paused' });
    await promo({ name: 'paused campaign', activationType: 'coupon_required', campaignId: paused.id, couponCodes: [{ code: `QAC${RUN}PAUSED` }] });
    const p = await apply(`QAC${RUN}PAUSED`);
    check('code', 'code of a paused campaign refused', p.status === 400 && /not available/i.test(p.message), `${p.status} ${p.message}`);

    const spent = await models.campaign.create({ name: `${PREFIX} spent campaign`, status: 'active', budgetMinor: 1000, usedBudgetMinor: 1000 });
    await promo({ name: 'budget used up', activationType: 'coupon_required', campaignId: spent.id, couponCodes: [{ code: `QAC${RUN}BUDGET` }] });
    const bu = await apply(`QAC${RUN}BUDGET`);
    check('code', 'code of a campaign with no budget left refused', bu.status === 400 && /no longer available/i.test(bu.message), `${bu.status} ${bu.message}`);

    await promo({ name: 'first order', benefitType: 'first_order_discount', discountValue: 25, activationType: 'coupon_required', couponCodes: [{ code: `QAC${RUN}FIRST` }] });
    const f = await apply(`QAC${RUN}FIRST`);
    check('code', 'first-order code refused for a returning customer', f.status === 400 && /first order/i.test(f.message), `${f.status} ${f.message}`);
    await archiveAll();
  }

  // ── B. Booking with a bad code: refused before anything is written ──
  {
    const before = await bookingCount();
    const bad = await book('bad code', { code: `NOPE${RUN}` });
    check('booking', 'unknown code: booking refused', bad.status === 404, `${bad.status} ${bad.message}`);
    const legacyCode = await admin('POST', '/addCoupon', { code: `QAC${RUN}OLD`, description: `${PREFIX} legacy`, discountType: 'percentage', discountValue: 10 });
    const old = await book('legacy code', { code: `QAC${RUN}OLD` });
    check('booking', 'legacy code: booking refused', legacyCode.status === 201 && old.status === 404, `${old.status} ${old.message}`);
    await promo({ name: 'card only', activationType: 'coupon_required', conditions: [{ conditionType: 'PAYMENT_METHOD', operator: 'in', value: ['card'] }], couponCodes: [{ code: `QAC${RUN}CARD` }] });
    const cash = await book('card-only code paid cash', { code: `QAC${RUN}CARD` });
    check('booking', 'card-only code on a cash booking: refused in plain words', cash.status === 400 && /only for card payments/i.test(cash.message), `${cash.status} ${cash.message}`);
    check('booking', 'no half-made bookings left behind by refused codes', (await bookingCount()) === before, `${before} → ${await bookingCount()}`);
    await archiveAll();
  }

  // ── C. Invoice rules ──
  {
    // Minimum spend £30: £24 → nothing; shop finds more (£33) → 10% applies; paid → committed
    const min30 = await promo({ name: 'min £30', minSubtotal: 30 });
    const b1 = await book('min spend reached');
    check('invoice', 'booking holds a promotion whose minimum is decided later', (await holdOf(b1.booking.id, min30.id))?.status === 'RESERVED');
    let d = await shopAdds(b1.booking.id, { standard: 2, wool: 1 });
    check('invoice', '£24 < £30 minimum: no discount', discountOf(d) === 0, `£${discountOf(d)}`);
    d = await shopAdds(b1.booking.id, { standard: 2, wool: 2 });
    check('invoice', 'shop finds more (£33): 10% = £3.30 applies', discountOf(d) === 3.3, `£${discountOf(d)}`);
    await payCash(b1.booking.id);
    check('invoice', 'paid: promotion committed at £3.30', Number((await holdOf(b1.booking.id, min30.id)).discountAmount) === 3.3 && (await holdOf(b1.booking.id, min30.id)).status === 'COMMITTED');

    const b2 = await book('min spend missed');
    d = await shopAdds(b2.booking.id, { standard: 2, wool: 1 });
    await payCash(b2.booking.id);
    check('invoice', 'minimum never reached: hold released at payment (not counted as a use)', discountOf(d) === 0 && (await holdOf(b2.booking.id, min30.id)).status === 'RELEASED');
    await archiveAll();

    // Paused between booking and invoice → not applied, released at payment
    const pauseLater = await promo({ name: 'paused after booking' });
    const b3 = await book('paused after booking');
    await admin('POST', `/promotions/${pauseLater.id}/pause`, {});
    d = await shopAdds(b3.booking.id);
    await payCash(b3.booking.id);
    check('invoice', 'promotion paused after booking: not applied, hold released', discountOf(d) === 0 && (await holdOf(b3.booking.id, pauseLater.id)).status === 'RELEASED', `£${discountOf(d)}`);
    await archiveAll();

    // Two automatic basket promotions, not stackable: the higher priority one wins
    const low = await promo({ name: 'basket 10% prio 50', discountValue: 10, priority: 50 });
    const high = await promo({ name: 'basket 20% prio 80', discountValue: 20, priority: 80 });
    const b4 = await book('stacking');
    d = await shopAdds(b4.booking.id);
    check('invoice', 'non-stackable: only the higher-priority 20% applies (£4.80 of £24)', discountOf(d) === 4.8, `£${discountOf(d)}`);
    await payCash(b4.booking.id);
    check('invoice', 'the one that lost is released, the winner committed', (await holdOf(b4.booking.id, low.id)).status === 'RELEASED' && (await holdOf(b4.booking.id, high.id)).status === 'COMMITTED');
    await archiveAll();
  }

  // ── D. Limits across bookings ──
  {
    const perCustomer = await promo({ name: 'once per customer auto', perCustomerLimit: 1 });
    const d1 = await book('per-customer 1');
    const d2 = await book('per-customer 2');
    check('limits', 'once per customer: first booking holds it, second does not', (await holdOf(d1.booking.id, perCustomer.id))?.status === 'RESERVED' && !(await holdOf(d2.booking.id, perCustomer.id)));
    await archiveAll();

    const global1 = await promo({ name: 'global limit 1', globalUsageLimit: 1 });
    const g1 = await book('global 1');
    const g2 = await book('global 2');
    check('limits', 'global limit 1: only the first booking gets it', (await holdOf(g1.booking.id, global1.id))?.status === 'RESERVED' && !(await holdOf(g2.booking.id, global1.id)));
    await archiveAll();
    for (const b of [d1, d2, g1, g2]) await cust('POST', '/cancelBooking', { bookingId: b.booking.id, reasonText: 'QA cleanup' });
  }

  // ── E. Card (Stripe TEST mode) ──
  {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const sc = await stripe.customers.create({ email: `qa-promo-cases-${RUN}@example.com`, name: 'QA Promo Cases' });
    const cardPromo = await promo({ name: 'card 10%' });

    const okCard = await book('card ok', { paymentType: 'card', paymentMethodId: 'pm_card_visa', stripeCustomerId: sc.id });
    check('card', 'card booking: authorisation hold placed, promotion held', okCard.status === 200 && Boolean(okCard.booking?.paymentIntentId) && (await holdOf(okCard.booking.id, cardPromo.id))?.status === 'RESERVED', `${okCard.status} ${okCard.message}`);
    if (okCard.booking) {
      const d = await shopAdds(okCard.booking.id);
      check('card', 'invoice: 10% of £24 = £2.40', discountOf(d) === 2.4, `£${discountOf(d)}`);
      const { attemptInvoiceCardCharge } = require('../services/Agent/invoiceAutoChargeService');
      const charge = await attemptInvoiceCardCharge(okCard.booking.id);
      const billing = await models.billingDetails.findOne({ where: { bookingId: okCard.booking.id } });
      check('card', 'balance charged on the test card, net of the discount', Boolean(charge?.ok) && billing.paymentStatus === 'Paid', JSON.stringify({ ok: charge?.ok, amount: charge?.amount, failure: charge?.failure?.message }));
      check('card', 'paid by card: promotion committed at £2.40', (await holdOf(okCard.booking.id, cardPromo.id)).status === 'COMMITTED' && Number((await holdOf(okCard.booking.id, cardPromo.id)).discountAmount) === 2.4);
    }

    // Declined when the card is attached (pm_card_chargeDeclined) and when the hold is placed
    // (pm_card_chargeCustomerFail attaches fine, then every charge fails).
    for (const [label, pm] of [['at attach', 'pm_card_chargeDeclined'], ['at the hold', 'pm_card_chargeCustomerFail']]) {
      const declined = await book(`card declined ${label}`, { paymentType: 'card', paymentMethodId: pm, stripeCustomerId: sc.id });
      check('card', `declined ${label}: booking refused with "Card authorization failed"`, declined.status === 400 && /card authorization failed/i.test(declined.message), `${declined.status} ${declined.message}`);
      check('card', `declined ${label}: booking cancelled and its promotion hold given back`, declined.booking?.bookingStatusId === 19 && (await holdOf(declined.booking.id, cardPromo.id))?.status === 'RELEASED', `status ${declined.booking?.bookingStatusId}`);
    }

    // Full refund by admin of the card-paid order: promotion reversed, budget given back
    if (okCard.booking) {
      const camp = await models.campaign.create({ name: `${PREFIX} refund budget`, status: 'active', budgetMinor: 100000, usedBudgetMinor: 240 });
      await models.promotion.update({ campaignId: camp.id }, { where: { id: cardPromo.id } });
      const rf = await admin('POST', `/bookings/${okCard.booking.id}/refund`, { mode: 'full', reason: 'QA full refund' });
      const h = await holdOf(okCard.booking.id, cardPromo.id);
      check('refund', 'admin full refund (Stripe test): promotion reversed, budget and usage given back', rf.status === 200 && h.status === 'REVERSED' && (await camp.reload()).usedBudgetMinor === 0, `${rf.status} ${rf.message} | ${h.status} | budget → ${camp.usedBudgetMinor}`);
    }
    await archiveAll();
  }

  // ── F. Cancel and refund through the real endpoints ──
  {
    const camp = await models.campaign.create({ name: `${PREFIX} refund budget`, status: 'active', budgetMinor: 100000 });
    const p = await promo({ name: 'cancel/refund 10%', campaignId: camp.id });

    const c1 = await book('customer cancels');
    const cc = await cust('POST', '/cancelBooking', { bookingId: c1.booking.id, reasonText: 'QA customer cancel' });
    check('cancel', 'customer cancels: hold released', cc.status === 200 && (await holdOf(c1.booking.id, p.id)).status === 'RELEASED', `${cc.status} ${cc.message}`);

    const c2 = await book('agent cancels');
    const ac = await agent('POST', '/agentCancelBooking', { bookingId: c2.booking.id, reasonText: 'QA agent cancel' });
    check('cancel', 'agent cancels: hold released', ac.status === 200 && (await holdOf(c2.booking.id, p.id)).status === 'RELEASED', `${ac.status} ${ac.message}`);

    await archiveAll();
    await models.promotion.update({ campaignId: null }, { where: { campaignId: camp.id } });
  }
}

async function cleanup() {
  await archiveAll().catch(() => {});
  await models.coupon.destroy({ where: { description: { [Op.like]: `${PREFIX}%` } } });
  const camps = await models.campaign.findAll({ where: { name: { [Op.like]: `${PREFIX}%` } }, attributes: ['id'] });
  await models.promotion.update({ campaignId: null }, { where: { campaignId: camps.map((c) => c.id) } });
  await models.campaign.destroy({ where: { id: camps.map((c) => c.id) } });
  if (redis) {
    await redis.hDel(`tsh${ADMIN_ID}`, 'promo-cases-admin');
    await redis.quit();
  }
}

main()
  .catch((err) => {
    console.error('SCRIPT ERROR', err);
    results.push(false);
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup', e.message));
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} passed`);
    await models.sequelize.close();
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });

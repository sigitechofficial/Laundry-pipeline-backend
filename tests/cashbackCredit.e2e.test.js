'use strict';

/**
 * Cashback paid as customer credit, end to end through the real HTTP endpoints of a LOCAL
 * stack (docs/CASHBACK_CREDIT_PLAN.md): offer → booking hold → invoice → payment → delivery →
 * credit → spent on the next invoice → cancel / refund. Positive and negative cases.
 *
 *   npm run test:cashback-e2e
 *
 * Needs: backend with PROMOTIONS_CHECKOUT_ENABLED=true and the test zone allowed, local
 * MySQL + Redis, Stripe TEST key. Leaves the test customer's credit at £0.
 * Env: PROMO_E2E_CUSTOMER_ID (3), PROMO_E2E_ADDRESS_ID (17).
 */

require('dotenv').config();
const assert = require('assert');
const jwt = require('jsonwebtoken');
const { createClient } = require('redis');
const { Op } = require('sequelize');
const models = require('../models');
const { signAdminAccessToken } = require('../utils/adminJwt');
const { findZones } = require('../utils/findZones');

const BASE = process.env.PROMO_TEST_BASE_URL || 'http://localhost:3010';
const ADMIN_ID = Number(process.env.PROMO_TEST_ADMIN_ID || 1);
const CUST_ID = Number(process.env.PROMO_E2E_CUSTOMER_ID || 3);
const ADDRESS_ID = Number(process.env.PROMO_E2E_ADDRESS_ID || 17);
const PREFIX = 'QA-CASHBACK';
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
  const dv = `cashback-e2e-${kind}`;
  if (kind === 'admin') {
    T[kind] = signAdminAccessToken({ id, email: `cashback-e2e-${id}@local`, dvToken: dv, zoneId: '' });
    await redis.hSet(`tsh${id}`, { [dv]: T[kind] });
  } else {
    T[kind] = jwt.sign({ id, dvToken: dv, userTypeId: kind === 'agent' ? 3 : 2 }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    await redis.hSet(`id-${id}`, { [dv]: T[kind] });
  }
}

let seq = 0;
async function promo(body) {
  seq += 1;
  const c = await admin('POST', '/promotions', {
    visibility: 'public', perCustomerLimit: null, zoneScopeMode: 'all', benefitType: 'cashback', discountMode: 'percent', discountValue: 10,
    ...body,
    name: `${PREFIX} ${seq} ${body.name || ''}`.trim(),
  });
  assert.strictEqual(c.status, 201, `create promotion "${body.name}": ${c.message}`);
  const p = await admin('POST', `/promotions/${c.json.data.id}/publish`, {});
  assert.strictEqual(p.status, 200, `publish "${body.name}": ${p.message}`);
  return p.json.data;
}
async function archiveAll() {
  for (const p of await models.promotion.findAll({ where: { name: { [Op.like]: `${PREFIX}%` }, status: { [Op.notIn]: ['archived'] } } })) {
    await admin('POST', `/promotions/${p.id}/archive`, {});
  }
}

const dayPlus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let address;
let zoneId;

async function book(tag, { paymentType = 'cash', paymentMethodId, stripeCustomerId } = {}) {
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
    driverInstruction: marker,
    driverInstructionOptions: 'Collect from me in person',
    driverInstructionOptions1: 'Deliver to me in person',
    timeZone: 'Europe/London',
  });
  const row = await models.booking.findOne({ where: { customerId: CUST_ID, driverInstruction: marker }, order: [['id', 'DESC']], attributes: ['id', 'bookingStatusId'] });
  assert.ok(row, `booking "${tag}" was not created: ${res.status} ${res.message}`);
  return row.id;
}

/** The shop adds Standard Trousers £7.50 ×2 + Wool £9 = £24. */
async function shopAdds(bookingId, { standard = 2, wool = 1 } = {}) {
  await models.booking.update({ bookingStatusId: 8 }, { where: { id: bookingId } });
  const services = [];
  if (standard) services.push({ serviceId: 2, categoryId: 1, subCategoryId: 1, items: standard });
  if (wool) services.push({ serviceId: 2, categoryId: 1, subCategoryId: 2, items: wool });
  const r = await agent('POST', '/AgentAddSerivces', { bookingId, services, timeZone: 'Europe/London' });
  assert.strictEqual(r.status, 200, `AgentAddSerivces: ${r.message}`);
  return detail(bookingId);
}
const detail = async (bookingId) => (await cust('GET', `/bookingDetailsById?bookingId=${bookingId}`)).json?.data || {};
const discountOf = (d) => Number(d.paymentSummary?.orderSummary?.discount || 0);
const dueOf = (d) => Number(d.paymentSummary?.amountDueNow || 0);
async function payCash(bookingId) {
  const d = await detail(bookingId);
  const r = await agent('POST', '/recordCashPayment', { bookingId, amountCollected: dueOf(d) });
  assert.strictEqual(r.status, 200, `recordCashPayment: ${r.message}`);
}
/** Driver at the customer's door marks it delivered (status 14 → Completed). */
async function deliver(bookingId) {
  await models.booking.update({ bookingStatusId: 14 }, { where: { id: bookingId } });
  return agent('PATCH', `/bookingDeliverToCustomer/${bookingId}`, {
    driverLat: Number(address.lat), driverLng: Number(address.lng), timeZone: 'Europe/London',
  });
}
const holdOf = (bookingId, promotionId) => models.promotionRedemption.findOne({ where: { bookingId, promotionId }, order: [['id', 'DESC']] });
const credit = async () => (await cust('GET', '/credit')).json?.data || {};
async function zeroCredit() {
  const c = await admin('GET', `/customerCredit/${CUST_ID}`);
  const bal = Number(c.json?.data?.balance || 0);
  if (bal > 0) await admin('POST', `/customerCredit/${CUST_ID}/adjust`, { amount: -bal, reason: `${PREFIX} reset` });
}

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
  await zeroCredit();

  // ── A. Admin credit endpoint: negative cases ──
  {
    const none = await admin('GET', '/customerCredit/99999999');
    check('admin', 'unknown customer → 404', none.status === 404, `${none.status}`);
    const noReason = await admin('POST', `/customerCredit/${CUST_ID}/adjust`, { amount: 5, reason: ' ' });
    check('admin', 'adjust without a reason refused', noReason.status === 400 && /reason/i.test(noReason.message), `${noReason.status} ${noReason.message}`);
    const zero = await admin('POST', `/customerCredit/${CUST_ID}/adjust`, { amount: 0, reason: 'x' });
    check('admin', 'adjust of £0 refused', zero.status === 400, `${zero.status} ${zero.message}`);
    const nan = await admin('POST', `/customerCredit/${CUST_ID}/adjust`, { amount: 'abc', reason: 'x' });
    check('admin', 'adjust with a non-number refused', nan.status === 400, `${nan.status} ${nan.message}`);
    const tooMuch = await admin('POST', `/customerCredit/${CUST_ID}/adjust`, { amount: -1, reason: 'remove' });
    check('admin', 'removing more than the balance refused', tooMuch.status === 400 && /only has £0.00/.test(tooMuch.message), `${tooMuch.status} ${tooMuch.message}`);
    const r1 = await admin('POST', `/customerCredit/${CUST_ID}/adjust`, { amount: 1, reason: 'double click', requestId: `qa-${RUN}` });
    const r2 = await admin('POST', `/customerCredit/${CUST_ID}/adjust`, { amount: 1, reason: 'double click', requestId: `qa-${RUN}` });
    check('admin', 'same requestId twice adds the credit once', r1.status === 200 && r2.status === 200 && Number(r2.json.data.balance) === 1, `balance £${r2.json?.data?.balance}`);
    const c = await credit();
    check('customer', 'GET /customer/credit shows the balance and history', Number(c.balance) === 1 && c.history?.entries?.[0]?.type === 'ADJUST', JSON.stringify({ b: c.balance, t: c.history?.entries?.[0]?.type }));
    await zeroCredit();
  }

  // ── B. Cashback earned after delivery ──
  const camp = await models.campaign.create({ name: `${PREFIX} budget`, status: 'active', budgetMinor: 100000 });
  const cb = await promo({ name: '10% cashback cap £5', maxDiscountCap: 5, campaignId: camp.id });
  {
    const offers = (await cust('GET', `/promotions/offers?zoneId=${zoneId}`)).json?.data || [];
    const offer = offers.find((o) => o.id === cb.id || o.promotionId === cb.id);
    check('offer', 'customer sees the cashback offer', Boolean(offer) && /10% cashback \(up to £5.00\)/.test(offer.label || ''), offer?.label);

    const b1 = await book('cashback cash');
    check('booking', 'booking holds the cashback promotion', (await holdOf(b1, cb.id))?.status === 'RESERVED');
    let d = await shopAdds(b1);
    check('invoice', 'cashback is not a discount: invoice discount £0', discountOf(d) === 0, `£${discountOf(d)}`);
    check('invoice', 'hold priced at 10% of £24 = £2.40 cashback', Number((await holdOf(b1, cb.id)).cashbackAmount) === 2.4);
    check('invoice', 'customer sees "£2.40 cashback ... after delivery"', d.promotionSummary?.cashback?.status === 'pending' && /2\.40 cashback will be added to your credit after delivery/.test(d.promotionSummary?.cashback?.message || ''), d.promotionSummary?.cashback?.message);
    await payCash(b1);
    check('payment', 'paid: cashback promotion committed (counts as a use)', (await holdOf(b1, cb.id)).status === 'COMMITTED');
    check('payment', 'campaign budget counts the £2.40 cashback', (await camp.reload()).usedBudgetMinor === 240, `${camp.usedBudgetMinor}`);
    check('payment', 'not delivered yet: no credit', Number((await credit()).balance) === 0);
    const dv = await deliver(b1);
    check('delivery', 'delivered (Completed) through the driver endpoint', dv.status === 200, `${dv.status} ${dv.message}`);
    const c = await credit();
    check('delivery', 'after delivery: £2.40 credit', Number(c.balance) === 2.4 && c.history.entries[0].type === 'EARN', `£${c.balance}`);
    d = await detail(b1);
    check('delivery', 'booking detail says the cashback was added', d.promotionSummary?.cashback?.status === 'credited', d.promotionSummary?.cashback?.message);
    await deliver(b1).catch(() => {});
    check('delivery', 'delivering again does not credit twice', Number((await credit()).balance) === 2.4);
  }

  // ── C. Next order: the £2.40 credit pays part of it; delivered before payment (cash at the door) ──
  {
    const b2 = await book('delivered then paid');
    const d = await shopAdds(b2);
    check('spend', 'next invoice uses the £2.40 credit automatically', discountOf(d) === 2.4 && d.promotionSummary?.creditUsed?.amount === 2.4 && d.promotionSummary?.creditUsed?.status === 'held', `discount £${discountOf(d)} ${JSON.stringify(d.promotionSummary?.creditUsed)}`);
    const c = await credit();
    check('spend', 'balance £0, £2.40 held for that order', Number(c.balance) === 0 && Number(c.held) === 2.4, JSON.stringify({ b: c.balance, h: c.held }));
    await deliver(b2);
    check('order', 'delivered but unpaid: no new cashback yet', Number((await credit()).balance) === 0);
    await payCash(b2);
    const after = await detail(b2);
    check('order', 'paid after delivery: its own £2.40 cashback credited then', Number((await credit()).balance) === 2.4, `£${(await credit()).balance}`);
    check('order', 'credit used on that order is now spent (paid)', after.promotionSummary?.creditUsed?.status === 'paid', JSON.stringify(after.promotionSummary?.creditUsed));
  }
  await archiveAll();

  // ── D. Cancel gives credit back; a paid invoice keeps its credit ──
  {
    const b3 = await book('credit then cancel');
    const d = await shopAdds(b3);
    check('spend', 'credit held on the new invoice', discountOf(d) === 2.4 && Number((await credit()).balance) === 0, `£${discountOf(d)}`);
    const cc = await agent('POST', '/agentCancelBooking', { bookingId: b3, reasonText: 'QA cancel' });
    check('spend', 'order cancelled after invoice: credit given back', cc.status === 200 && Number((await credit()).balance) === 2.4, `${cc.status} £${(await credit()).balance}`);
    await detail(b3);
    check('spend', 'viewing the cancelled order does not grab the credit again', Number((await credit()).balance) === 2.4, `£${(await credit()).balance}`);

    const usedOn = await book('credit paid');
    await shopAdds(usedOn);
    await payCash(usedOn);
    const after = await detail(usedOn);
    check('spend', 'paid: credit spent for good, balance £0', Number((await credit()).balance) === 0 && after.promotionSummary?.creditUsed?.status === 'paid', JSON.stringify(after.promotionSummary?.creditUsed));
    await admin('POST', `/customerCredit/${CUST_ID}/adjust`, { amount: 3, reason: `${PREFIX} after paid` });
    check('spend', 'a paid invoice is not re-priced with new credit', discountOf(await detail(usedOn)) === 2.4 && Number((await credit()).balance) === 3, `£${discountOf(await detail(usedOn))}`);
    await zeroCredit();
  }

  // ── E. Credit never goes over what is payable ──
  {
    await admin('POST', `/customerCredit/${CUST_ID}/adjust`, { amount: 100, reason: `${PREFIX} big credit` });
    const b5 = await book('credit bigger than bill');
    const d = await shopAdds(b5);
    const used = d.promotionSummary?.creditUsed?.amount;
    check('cap', 'credit covers the whole bill, never more: due £0', dueOf(d) === 0 && used > 0 && used < 100, `due £${dueOf(d)}, credit used £${used}`);
    check('cap', 'the rest stays in the balance', Math.round((Number((await credit()).balance) + used) * 100) === 10000, `£${(await credit()).balance}`);
    await agent('POST', '/agentCancelBooking', { bookingId: b5, reasonText: 'QA cancel' });
    check('cap', 'cancelled: full £100 back', Number((await credit()).balance) === 100);
    await zeroCredit();
  }

  // ── F. Refunds (card, Stripe TEST) ──
  {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const sc = await stripe.customers.create({ email: `qa-cashback-${RUN}@example.com`, name: 'QA Cashback' });
    const { attemptInvoiceCardCharge } = require('../services/Agent/invoiceAutoChargeService');
    const cb2 = await promo({ name: 'card cashback' });

    // Refund of the order that earned cashback: unspent cashback taken back
    const b6 = await book('card cashback refund', { paymentType: 'card', paymentMethodId: 'pm_card_visa', stripeCustomerId: sc.id });
    await shopAdds(b6);
    const charge = await attemptInvoiceCardCharge(b6);
    await deliver(b6);
    check('refund', 'card order paid and delivered: £2.40 cashback credited', Boolean(charge?.ok) && Number((await credit()).balance) === 2.4, `charge ${charge?.ok} £${(await credit()).balance}`);
    const rf = await admin('POST', `/bookings/${b6}/refund`, { mode: 'full', reason: 'QA full refund' });
    const c6 = await credit();
    check('refund', 'full refund: unspent cashback taken back (balance £0, never negative)', rf.status === 200 && Number(c6.balance) === 0 && c6.history.entries.some((e) => e.type === 'REVERSE'), `${rf.status} ${rf.message} £${c6.balance}`);
    const d6 = await detail(b6);
    check('refund', 'booking detail says the £2.40 cashback was taken back', d6.promotionSummary?.cashback?.status === 'taken_back' && /£2\.40 cashback was taken back/.test(d6.promotionSummary?.cashback?.message || ''), d6.promotionSummary?.cashback?.message);
    await archiveAll();

    // Refund of an order paid partly with credit: the credit comes back
    await admin('POST', `/customerCredit/${CUST_ID}/adjust`, { amount: 5, reason: `${PREFIX} for refund` });
    const b7 = await book('card paid with credit', { paymentType: 'card', paymentMethodId: 'pm_card_visa', stripeCustomerId: sc.id });
    const d7 = await shopAdds(b7);
    const charge7 = await attemptInvoiceCardCharge(b7);
    check('refund', 'card balance charged net of £5 credit', Boolean(charge7?.ok) && discountOf(d7) === 5 && Number((await credit()).balance) === 0, `charge ${charge7?.ok} amount ${charge7?.amount} discount £${discountOf(d7)}`);
    const rf7 = await admin('POST', `/bookings/${b7}/refund`, { mode: 'full', reason: 'QA full refund' });
    check('refund', 'full refund: the £5 credit is given back', rf7.status === 200 && Number((await credit()).balance) === 5, `${rf7.status} ${rf7.message} £${(await credit()).balance}`);
    const d7b = await detail(b7);
    check('refund', 'booking detail shows the £5 credit returned', d7b.promotionSummary?.creditUsed?.returned === 5, JSON.stringify(d7b.promotionSummary?.creditUsed));
  }
}

async function cleanup() {
  await archiveAll().catch(() => {});
  await zeroCredit().catch(() => {});
  const camps = await models.campaign.findAll({ where: { name: { [Op.like]: `${PREFIX}%` } }, attributes: ['id'] });
  await models.promotion.update({ campaignId: null }, { where: { campaignId: camps.map((c) => c.id) } });
  await models.campaign.destroy({ where: { id: camps.map((c) => c.id) } });
  // Close this run's test bookings so their holds never touch later runs.
  await models.booking.update(
    { bookingStatusId: 19 },
    { where: { customerId: CUST_ID, driverInstruction: { [Op.like]: `${PREFIX} ${RUN}%` }, bookingStatusId: { [Op.notIn]: [17, 19, 21] } } }
  );
  if (redis) {
    await redis.hDel(`tsh${ADMIN_ID}`, 'cashback-e2e-admin');
    await redis.hDel(`id-${CUST_ID}`, 'cashback-e2e-cust');
    await redis.hDel(`id-${ADMIN_ID}`, 'cashback-e2e-agent');
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

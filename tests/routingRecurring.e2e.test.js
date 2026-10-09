'use strict';

/**
 * Shop routing + recurring fixes, through the real HTTP endpoints of a LOCAL stack.
 *   npm run test:routing
 *
 * Needs two shops in one zone, so for the run it borrows shop address 3 (owner 38):
 * moves it into zone 3 next to shop 16 (owner 44), gives it service 2 and shop 44's
 * opening hours. Everything is put back afterwards, as are the customer's shop
 * assignment / exclusions. Bookings are marked "QA-ROUTING" and closed after.
 */

require('dotenv').config();
const assert = require('assert');
const jwt = require('jsonwebtoken');
const { createClient } = require('redis');
const { Op } = require('sequelize');
const models = require('../models');
const { signAdminAccessToken } = require('../utils/adminJwt');
const { nextCycleDates } = require('../services/Customer/recurringBookingService');

const BASE = process.env.PROMO_TEST_BASE_URL || 'http://localhost:3010';
const ADMIN_ID = 1;
const CUST_ID = 3;
const ADDRESS_ID = 17;
const SHOP_A = { addressId: 16, owner: 44, businessId: 4 }; // customer's usual shop
const SHOP_B = { addressId: 3, owner: 38, businessId: 3 }; // borrowed into zone 3
const PREFIX = 'QA-ROUTING';
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
let redis;
async function session(kind, id, userTypeId) {
  const dv = `routing-e2e-${kind}`;
  if (kind === 'admin') {
    T[kind] = signAdminAccessToken({ id, email: `routing-${id}@local`, dvToken: dv, zoneId: '' });
    await redis.hSet(`tsh${id}`, { [dv]: T[kind] });
  } else {
    T[kind] = jwt.sign({ id, dvToken: dv, userTypeId }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    await redis.hSet(`id-${id}`, { [dv]: T[kind] });
  }
}
const admin = (m, u, b) => call(m, `/admin${u}`, b, 'admin');
const cust = (m, u, b) => call(m, `/customer${u}`, b, 'cust');
const shopA = (m, u, b) => call(m, `/agent${u}`, b, 'shopA');
const shopB = (m, u, b) => call(m, `/agent${u}`, b, 'shopB');

const dayPlus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let base;
let address;
let hour = 8;

async function book(tag, extra = {}) {
  hour += 1;
  const from = `${String(hour).padStart(2, '0')}:00`;
  const to = `${String(hour + 1).padStart(2, '0')}:00`;
  const marker = `${PREFIX} ${RUN} ${tag}`;
  const res = await cust('POST', '/createBooking', {
    collectionDate: dayPlus(base), collectionTimeFrom: from, collectionTimeTo: to,
    deliveryDate: dayPlus(base + 3), deliveryTimeFrom: from, deliveryTimeTo: to,
    frequency: 'Just Once',
    pickUpAddress: { lat: Number(address.lat), lng: Number(address.lng) },
    pickUpAddressId: address.id,
    dropOffSamePickUp: true,
    services: [{ serviceId: 2, categoryId: 1, subCategoryId: 1, items: 2 }],
    totalItems: 2,
    totalBags: 1,
    paymentType: 'cash',
    tipAmount: 0,
    driverInstruction: marker,
    driverInstructionOptions: 'Collect from me in person',
    driverInstructionOptions1: 'Deliver to me in person',
    timeZone: 'Europe/London',
    ...extra,
  });
  const row = await models.booking.findOne({ where: { customerId: CUST_ID, driverInstruction: marker }, order: [['id', 'DESC']] });
  return { res, row };
}
const reload = (id) => models.booking.findByPk(id);
const listIds = async (who) => ((await who('GET', '/getBookingHome?timeZone=Europe/London')).json?.data?.bookingData || []).map((b) => Number(b.id));

const saved = {};

async function borrowShopB() {
  const a16 = await models.addressDb.findByPk(SHOP_A.addressId);
  const a3 = await models.addressDb.findByPk(SHOP_B.addressId);
  saved.shopB = { zoneId: a3.zoneId, lat: a3.lat, lng: a3.lng, status: a3.status };
  await a3.update({ zoneId: a16.zoneId, lat: Number(a16.lat) + 0.01, lng: Number(a16.lng) + 0.01, status: true });
  saved.service = await models.agentSelectServices.create({ agentServiceId: SHOP_B.owner, serviceId: 2, status: true, serviceTimeRequired: 3 });
  const hours = await models.bussinessWorkingHours.findAll({ where: { userId: SHOP_A.owner } });
  saved.hours = [];
  for (const h of hours) {
    saved.hours.push(await models.bussinessWorkingHours.create({
      dayOfWeek: h.dayOfWeek, openTime: h.openTime, closeTime: h.closeTime, status: h.status,
      bussinessInformationId: SHOP_B.businessId, userId: SHOP_B.owner,
    }));
  }
  saved.assignments = (await models.customerShopAssignment.findAll({ where: { customerId: CUST_ID, status: 'active' }, attributes: ['id'] })).map((r) => r.id);
  saved.exclusions = (await models.customerShopExclusion.findAll({ where: { customerId: CUST_ID }, attributes: ['id'] })).map((r) => r.id);
}

async function restore() {
  if (saved.shopB) await models.addressDb.update(saved.shopB, { where: { id: SHOP_B.addressId } });
  if (saved.service) await saved.service.destroy({ force: true }).catch(() => {});
  for (const h of saved.hours || []) await h.destroy({ force: true }).catch(() => {});
  if (saved.assignments) {
    await models.customerShopAssignment.update({ status: 'unlinked' }, { where: { customerId: CUST_ID, status: 'active', id: { [Op.notIn]: saved.assignments.length ? saved.assignments : [0] } } });
    if (saved.assignments.length) await models.customerShopAssignment.update({ status: 'active' }, { where: { id: saved.assignments } });
  }
  if (saved.exclusions) {
    await models.customerShopExclusion.destroy({ where: { customerId: CUST_ID, id: { [Op.notIn]: saved.exclusions.length ? saved.exclusions : [0] } } });
  }
  await models.booking.update(
    { bookingStatusId: 19 },
    // Every booking of this run, the completed history one included.
    { where: { customerId: CUST_ID, driverInstruction: { [Op.like]: `${PREFIX} ${RUN}%` }, bookingStatusId: { [Op.notIn]: [19, 21] } } }
  );
}

async function main() {
  assert.strictEqual(process.env.NODE_ENV, 'development', 'NODE_ENV must be development');
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(String(models.sequelize.config.host)), 'local database only');
  redis = createClient({ url: 'redis://127.0.0.1:6379' });
  await redis.connect();
  await session('admin', ADMIN_ID);
  await session('cust', CUST_ID, 2);
  await session('shopA', SHOP_A.owner, 4);
  await session('shopB', SHOP_B.owner, 4);
  address = await models.addressDb.findByPk(ADDRESS_ID);
  base = 9 + 7 * (RUN % 4);
  while (new Date(Date.now() + base * 86400000).getUTCDay() !== 3) base += 1; // Wednesdays
  await borrowShopB();
  // History: the customer completed an order at shop A (their usual shop).
  const history = await book('H completed at shop A');
  await models.booking.update({ laundryShopId: SHOP_A.addressId, bookingStatusId: 17 }, { where: { id: history.row.id } });

  // ── Preferred (returning) shop window ──
  const b1 = await book('B1 preferred window');
  check('preferred', 'returning customer: order offered to the usual shop first (phase 1)',
    Number(b1.row?.preferredShopAgentId) === SHOP_A.owner && b1.row?.preferredShopBroadcastDone === false,
    `preferred=${b1.row?.preferredShopAgentId} done=${b1.row?.preferredShopBroadcastDone}`);
  check('preferred', 'other shop does not see it during the window', !(await listIds(shopB)).includes(b1.row.id));
  const early = await shopB('POST', '/acceptOrder', { bookingId: b1.row.id });
  check('preferred', 'other shop cannot accept during the window', early.status === 409 && /usual shop first/.test(early.message), `${early.status} ${early.message}`);

  const decline = await shopA('POST', '/rejectOrder', { bookingId: b1.row.id, reason: 'Too busy' });
  const afterDecline = await reload(b1.row.id);
  check('decline', 'usual shop declines → opened to all shops', decline.status === 200 && afterDecline.preferredShopBroadcastDone === true, `${decline.status} ${decline.message}`);
  check('decline', 'the shop that declined does not get it back in its list', !(await listIds(shopA)).includes(b1.row.id));
  check('decline', 'the other shop now sees it', (await listIds(shopB)).includes(b1.row.id));
  const takeB1 = await shopB('POST', '/acceptOrder', { bookingId: b1.row.id });
  check('decline', 'the other shop accepts it', takeB1.status === 200, `${takeB1.status} ${takeB1.message}`);

  // ── Customer moved to another shop ──
  const b3 = await book('B3 accepted by usual shop');
  const acceptB3 = await shopA('POST', '/acceptOrder', { bookingId: b3.row.id });
  const b2 = await book('B2 waiting, then customer moved');
  check('move', 'setup: B3 accepted by shop A, B2 waiting for shop A', acceptB3.status === 200 && Number(b2.row?.preferredShopAgentId) === SHOP_A.owner);
  const move = await admin('POST', `/customers/${CUST_ID}/shop-assignment`, { shopId: SHOP_B.addressId, note: 'QA move' });
  const open = move.json?.data?.openOrders;
  check('move', 'admin assigns the customer to shop B', move.status === 200, `${move.status} ${move.message}`);
  check('move', 'waiting order is offered to the new shop first', Number((await reload(b2.row.id)).preferredShopAgentId) === SHOP_B.owner && (open?.rerouted || []).some((r) => r.bookingId === b2.row.id && r.mode === 'preferred'), JSON.stringify(open?.rerouted));
  check('move', 'accepted order still with the old shop is listed for the admin', (open?.stillWithOtherShop || []).some((o) => o.bookingId === b3.row.id), JSON.stringify(open?.stillWithOtherShop));
  const nextB = await book('B4 after move');
  check('move', 'new orders go to the new shop first', Number(nextB.row?.preferredShopAgentId) === SHOP_B.owner, `preferred=${nextB.row?.preferredShopAgentId}`);

  // ── Customer excluded from shop B ──
  const ex = await admin('POST', '/customerShopExclusions', { customerId: CUST_ID, shopId: SHOP_B.addressId, reason: 'QA exclude' });
  const exOpen = ex.json?.data?.openOrders;
  const b2After = await reload(b2.row.id);
  check('exclude', 'excluding the customer from shop B', ex.status === 200 || ex.status === 201, `${ex.status} ${ex.message}`);
  check('exclude', 'waiting orders leave shop B (no preferred offer to an excluded shop)', Number(b2After.preferredShopAgentId) !== SHOP_B.owner, `preferred=${b2After.preferredShopAgentId}`);
  check('exclude', "shop B's accepted order is listed for the admin", (exOpen?.stillWithOtherShop || []).some((o) => o.bookingId === b1.row.id), JSON.stringify(exOpen?.stillWithOtherShop));
  const bAccept = await shopB('POST', '/acceptOrder', { bookingId: nextB.row.id });
  check('exclude', 'shop B can no longer accept this customer', bAccept.status === 409, `${bAccept.status} ${bAccept.message}`);

  // ── Admin reassign: delivery driver cleared, two admins at once ──
  await models.booking.update({ deliveryDriverId: SHOP_B.owner }, { where: { id: b1.row.id } });
  const re = await admin('PATCH', `/bookings/${b1.row.id}/assignShop`, { laundryShopId: SHOP_A.addressId });
  const b1After = await reload(b1.row.id);
  check('reassign', 'admin moves the order to shop A; old delivery driver cleared', re.status === 200 && Number(b1After.laundryShopId) === SHOP_A.addressId && b1After.deliveryDriverId == null, `${re.status} ${re.message} driver=${b1After.deliveryDriverId}`);
  const [r1, r2] = await Promise.all([
    admin('PATCH', `/bookings/${b3.row.id}/assignShop`, { laundryShopId: SHOP_B.addressId }),
    admin('PATCH', `/bookings/${b3.row.id}/assignShop`, { laundryShopId: SHOP_B.addressId }),
  ]);
  const okCount = [r1, r2].filter((r) => r.status === 200).length;
  check('reassign', 'two admins assigning at once: only one change goes through', okCount === 1, `${r1.status} ${r1.message} | ${r2.status} ${r2.message}`);

  // ── Deactivated shop ──
  await models.addressDb.update({ status: false }, { where: { id: SHOP_A.addressId } });
  const dead = await book('B5 deactivated shop');
  const deadAccept = await shopA('POST', '/acceptOrder', { bookingId: dead.row.id });
  check('deactivated', 'deactivated shop cannot accept and sees no new orders', deadAccept.status === 409 && /deactivated/.test(deadAccept.message) && (await listIds(shopA)).length === 0, `${deadAccept.status} ${deadAccept.message}`);
  await models.addressDb.update({ status: true }, { where: { id: SHOP_A.addressId } });

  // ── Recurring ──
  const now = new Date('2026-10-09T10:00:00Z');
  const paused = nextCycleDates('2026-09-01', '2026-09-04', 7, now);
  check('recurring', 'next cycle never lands in the past (paused 5 weeks → next week)', paused.collection.toISOString().slice(0, 10) === '2026-10-13' && paused.skippedCycles === 5);
  const today = nextCycleDates('2026-10-02', '2026-10-05', 7, now);
  check('recurring', 'next cycle never lands on today (moved one more week)', today.collection.toISOString().slice(0, 10) === '2026-10-16');

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sc = await stripe.customers.create({ email: `qa-routing-${RUN}@example.com`, name: 'QA Routing' });
  const declined = await book('R1 weekly declined card', { frequency: 'Weekly', paymentType: 'card', paymentMethodId: 'pm_card_chargeDeclined', stripeCustomerId: sc.id });
  const planForDeclined = declined.row ? await models.recurringPlan.count({ where: { sourceBookingId: declined.row.id } }) : 0;
  check('recurring', 'card declined at booking → no recurring plan left behind', declined.res.status >= 400 && planForDeclined === 0, `${declined.res.status} plans=${planForDeclined}`);

  const weekly = await book('R2 weekly cash', { frequency: 'Weekly' });
  const plan = await models.recurringPlan.findOne({ where: { sourceBookingId: weekly.row.id } });
  check('recurring', 'successful Weekly booking gets an active plan', plan?.status === 'active');
  const pause = await cust('POST', '/recurringPlan', { bookingId: weekly.row.id, action: 'pause' });
  const edit = await admin('PATCH', `/editOrder/${weekly.row.id}`, { frequency: 'Weekly', driverInstruction: `${PREFIX} ${RUN} R2 weekly cash` });
  await plan.reload();
  check('recurring', 'admin edits the order without changing frequency → paused plan stays paused', pause.status === 200 && plan.status === 'paused', `pause ${pause.status} edit ${edit.status} ${edit.message} plan=${plan.status}`);
  await cust('POST', '/recurringPlan', { bookingId: weekly.row.id, action: 'resume' });
  const cancel = await cust('POST', '/cancelBooking', { bookingId: weekly.row.id, reasonText: 'QA cancel' });
  check('recurring', 'cancelling one weekly order says the plan is still on and where to stop it', cancel.status === 200 && /plan is still on/.test(cancel.message), `${cancel.status} ${cancel.message}`);
  await cust('POST', '/recurringPlan', { bookingId: weekly.row.id, action: 'cancel' });

  const perm = require('../utils/adminRoutePermissions').resolveAdminFeatureKey('/orders/12/recurringPlan');
  check('recurring', 'order-page recurring action has a permission (not super-admin only)', perm === 'orderManagement', perm);
}

main()
  .catch((err) => {
    console.error('SCRIPT ERROR', err);
    results.push(false);
  })
  .finally(async () => {
    await restore().catch((e) => console.error('restore', e.message));
    if (redis) {
      for (const [k, f] of [[`tsh${ADMIN_ID}`, 'routing-e2e-admin'], [`id-${CUST_ID}`, 'routing-e2e-cust'], [`id-${SHOP_A.owner}`, 'routing-e2e-shopA'], [`id-${SHOP_B.owner}`, 'routing-e2e-shopB']]) await redis.hDel(k, f).catch(() => {});
      await redis.quit();
    }
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} passed`);
    await models.sequelize.close();
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });

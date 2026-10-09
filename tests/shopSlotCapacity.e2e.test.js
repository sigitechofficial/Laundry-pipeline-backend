'use strict';

/**
 * Slot-wise shop capacity through the real HTTP endpoints of a LOCAL stack
 * (utils/shopSlotCapacity.js). Positive and negative cases:
 * room per pickup/delivery slot, other slots / days, cancel frees room, full
 * orders hidden from the agent list, capacity 0, capacity off (1 per slot),
 * two accepts racing for the last place, admin assign list.
 *
 *   npm run test:slot-capacity
 *
 * Env: SLOT_E2E_CUSTOMER_ID (3), SLOT_E2E_ADDRESS_ID (17, zone 3),
 *      SLOT_E2E_AGENT_ID (44 = owner of the zone-3 shop).
 * Creates bookings marked "QA-SLOT-CAP" in driverInstruction and closes them after.
 */

require('dotenv').config();
const assert = require('assert');
const jwt = require('jsonwebtoken');
const { createClient } = require('redis');
const { Op } = require('sequelize');
const models = require('../models');
const { signAdminAccessToken } = require('../utils/adminJwt');
const { countJobsInSlot } = require('../utils/shopSlotCapacity');
const { findZones } = require('../utils/findZones');

const BASE = process.env.PROMO_TEST_BASE_URL || 'http://localhost:3010';
const ADMIN_ID = 1;
const CUST_ID = Number(process.env.SLOT_E2E_CUSTOMER_ID || 3);
const ADDRESS_ID = Number(process.env.SLOT_E2E_ADDRESS_ID || 17);
const AGENT_ID = Number(process.env.SLOT_E2E_AGENT_ID || 44);
const PREFIX = 'QA-SLOT-CAP';
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
async function session(kind, id, userTypeId) {
  const dv = `slot-cap-${kind}`;
  if (kind === 'admin') {
    T[kind] = signAdminAccessToken({ id, email: `slot-cap-${id}@local`, dvToken: dv, zoneId: '' });
    await redis.hSet(`tsh${id}`, { [dv]: T[kind] });
  } else {
    T[kind] = jwt.sign({ id, dvToken: dv, userTypeId }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    await redis.hSet(`id-${id}`, { [dv]: T[kind] });
  }
}

const dayPlus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let address;
let shop;

/** A cash booking with the given pickup / delivery slots. */
async function book(tag, { pDay, pFrom, pTo, dDay, dFrom, dTo }) {
  const marker = `${PREFIX} ${RUN} ${tag}`;
  const res = await cust('POST', '/createBooking', {
    collectionDate: pDay, collectionTimeFrom: pFrom, collectionTimeTo: pTo,
    deliveryDate: dDay, deliveryTimeFrom: dFrom, deliveryTimeTo: dTo,
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
  });
  const row = await models.booking.findOne({ where: { customerId: CUST_ID, driverInstruction: marker }, order: [['id', 'DESC']], attributes: ['id'] });
  assert.ok(row, `booking "${tag}" not created: ${res.status} ${res.message}`);
  return row.id;
}
const accept = (bookingId) => agent('POST', '/acceptOrder', { bookingId, timeZone: 'Europe/London' });
const setCap = (body) => admin('PATCH', `/shopAssignmentPolicy/${AGENT_ID}`, body);
async function newListIds() {
  const r = await agent('GET', '/getBookingHome?timeZone=Europe/London');
  return (r.json?.data?.bookingData || []).map((b) => Number(b.id));
}

let policyBefore;

async function main() {
  assert.strictEqual(process.env.NODE_ENV, 'development', 'NODE_ENV must be development');
  assert.ok(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE), 'local backend only');
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(String(models.sequelize.config.host)), 'local database only');

  redis = createClient({ url: 'redis://127.0.0.1:6379' });
  await redis.connect();
  await session('admin', ADMIN_ID);
  await session('cust', CUST_ID, 2);
  await session('agent', AGENT_ID, 4);

  address = await models.addressDb.findByPk(ADDRESS_ID);
  shop = await models.addressDb.findOne({ where: { userId: AGENT_ID, addressType: 'LaundaryShopAddress' } });
  assert.ok(address && shop, 'test address and shop must exist');
  const zoneId = (await findZones(Number(address.lat), Number(address.lng)))?.[0]?.id;
  assert.strictEqual(Number(zoneId), Number(shop.zoneId), 'shop must serve the address zone');

  policyBefore = (await admin('GET', `/shopAssignmentPolicy/${AGENT_ID}`)).json?.data || {};

  // Pickups on Tue/Wed/Thu (shops are open), far from other test data; each run
  // moves a week so earlier runs' bookings never share its slots.
  let base = 9 + 7 * (RUN % 4);
  while (new Date(Date.now() + base * 86400000).getUTCDay() !== 2) base += 1;
  const P = { pDay: dayPlus(base), pFrom: '13:00', pTo: '14:00' };
  const D = { dDay: dayPlus(base + 3), dFrom: '16:00', dTo: '17:00' };
  const startLoad = await countJobsInSlot(shop.id, { day: P.pDay, start: '13:00:00', end: '14:00:00' });
  assert.strictEqual(startLoad.total, 0, 'chosen pickup slot must start empty');

  // ── Capacity 2 per slot for this shop ──
  const set = await setCap({ acceptCapOverride: true, acceptMaxOrders: 2 });
  check('setup', 'admin sets this shop to 2 per slot', set.status === 200, `${set.status} ${set.message}`);
  const cap = (await agent('GET', '/acceptCapacity')).json?.data?.capacity;
  check('status', 'agent capacity: slot mode, limit 2; old rolling fields off for old apps',
    cap?.slotCapacity?.mode === 'slot' && cap?.slotCapacity?.limit === 2 && cap?.enabled === false && cap?.atCapacity === false,
    JSON.stringify({ e: cap?.enabled, s: cap?.slotCapacity && { m: cap.slotCapacity.mode, l: cap.slotCapacity.limit } }));

  const a = await book('A same slot', { ...P, ...D });
  const b = await book('B same slot', { ...P, ...D });
  const c = await book('C same slot', { ...P, ...D });
  const d = await book('D other pickup + delivery slot', { pDay: P.pDay, pFrom: '11:00', pTo: '12:00', dDay: D.dDay, dFrom: '18:00', dTo: '19:00' });
  const e = await book('E same hours other day', { pDay: dayPlus(base + 1), pFrom: '13:00', pTo: '14:00', dDay: dayPlus(base + 4), dFrom: '16:00', dTo: '17:00' });
  const f = await book('F free pickup, full delivery slot', { pDay: P.pDay, pFrom: '15:00', pTo: '16:00', ...D });

  check('list', 'before any accept the agent sees all six orders', (await newListIds()).filter((id) => [a, b, c, d, e, f].includes(id)).length === 6);

  const ra = await accept(a);
  const rb = await accept(b);
  check('accept', '1st and 2nd order in the 13:00 slot accepted (2 of 2)', ra.status === 200 && rb.status === 200, `${ra.status} ${rb.status} ${rb.message}`);

  const rc = await accept(c);
  check('accept', '3rd order in the same pickup slot refused', rc.status === 409 && rc.json?.code !== 'SHOP_ACCEPT_CAP_REACHED', `${rc.status} ${rc.message}`);
  check('message', 'refusal says which slot is full, in plain words',
    /pickup( and delivery)? slot .* 13:00–14:00 is full \(2 of 2 pickups and deliveries\)/.test(rc.message), rc.message);
  check('accept', 'the refused order stays open for other shops', (await models.booking.findByPk(c)).bookingStatusId === 1);

  const ids = await newListIds();
  check('list', 'full-slot orders are hidden from the agent list (C and F)', !ids.includes(c) && !ids.includes(f), `list has C=${ids.includes(c)} F=${ids.includes(f)}`);
  check('list', 'orders with room still show (D, E)', ids.includes(d) && ids.includes(e));

  const rf = await accept(f);
  check('accept', 'free pickup slot but full delivery slot → refused', rf.status === 409 && /delivery slot/.test(rf.message), rf.message);
  const rd = await accept(d);
  check('accept', 'other pickup + delivery slot same day → accepted', rd.status === 200, `${rd.status} ${rd.message}`);
  const re = await accept(e);
  check('accept', 'same hours on another day → accepted', re.status === 200, `${re.status} ${re.message}`);

  const status = (await agent('GET', '/acceptCapacity')).json?.data?.capacity?.slotCapacity;
  const slot13 = status?.upcoming?.find((s) => s.date === P.pDay && s.from === '13:00');
  check('status', 'upcoming slot load shows 13:00 as 2 of 2 full', slot13?.used === 2 && slot13?.full === true, JSON.stringify(slot13));

  // ── Admin assign list shows room per shop ──
  const assignable = await admin('GET', `/bookings/${c}/assignableShops`);
  const row = (assignable.json?.data?.shops || []).find((s) => Number(s.laundryShopId) === Number(shop.id));
  check('admin', 'assign list: this shop has no room in C\'s slot', row?.slotCapacity?.hasRoom === false, JSON.stringify(row?.slotCapacity));

  // ── Cancel frees the room ──
  const cancel = await cust('POST', '/cancelBooking', { bookingId: a, reasonText: 'QA slot test' });
  check('cancel', 'customer cancels an accepted order', cancel.status === 200, `${cancel.status} ${cancel.message}`);
  check('list', 'after the cancel, C shows again', (await newListIds()).includes(c));
  const rc2 = await accept(c);
  check('accept', 'C accepted into the freed place', rc2.status === 200, `${rc2.status} ${rc2.message}`);

  // ── Raise the limit: more room right away ──
  await setCap({ acceptCapOverride: true, acceptMaxOrders: 3 });
  const g = await book('G after raise', { ...P, pFrom: '13:00', dDay: dayPlus(base + 5), dFrom: '10:00', dTo: '11:00' });
  const rg = await accept(g);
  check('accept', 'limit raised to 3 → a 3rd order fits the 13:00 slot', rg.status === 200, `${rg.status} ${rg.message}`);

  // ── Two accepts racing for the last place ──
  await setCap({ acceptCapOverride: true, acceptMaxOrders: 4 });
  const h1 = await book('H1 race', { ...P, dDay: dayPlus(base + 6), dFrom: '10:00', dTo: '11:00' });
  const h2 = await book('H2 race', { ...P, dDay: dayPlus(base + 6), dFrom: '12:00', dTo: '13:00' });
  const [x1, x2] = await Promise.all([accept(h1), accept(h2)]);
  const ok = [x1, x2].filter((r) => r.status === 200).length;
  const load = await countJobsInSlot(shop.id, { day: P.pDay, start: '13:00:00', end: '14:00:00' });
  check('race', 'two accepts for the last place: exactly one wins, slot never over the limit', ok === 1 && load.total === 4, `${x1.status}/${x2.status}, load ${load.total}`);

  // ── New booking into a slot every shop has full: held, admin alerted ──
  const y = await book('Y booked into a full slot', { ...P, dDay: dayPlus(base + 6), dFrom: '14:00', dTo: '15:00' });
  const yRow = await models.booking.findByPk(y, { attributes: ['id', 'agentBroadcastHeld', 'bookingStatusId', 'laundryShopId'] });
  check('booking', 'booking into a full slot is still created (customer not blocked)', yRow?.bookingStatusId === 1 && yRow.laundryShopId == null);
  check('booking', 'no shop has room: booking held for later / manual assign', yRow?.agentBroadcastHeld === true, `held=${yRow?.agentBroadcastHeld}`);

  // ── Capacity 0 ──
  await setCap({ acceptCapOverride: true, acceptMaxOrders: 0 });
  const z = await book('Z cap zero', { pDay: dayPlus(base + 2), pFrom: '09:00', pTo: '10:00', dDay: dayPlus(base + 7), dFrom: '09:00', dTo: '10:00' });
  const rz = await accept(z);
  check('accept', 'capacity 0 → refused with a clear message', rz.status === 409 && /capacity set to 0/.test(rz.message), rz.message);
  check('list', 'capacity 0 → nothing new in the list', !(await newListIds()).includes(z));

  // ── Capacity off for this shop (and globally off) → one per slot ──
  await setCap({ acceptCapOverride: false });
  const offStatus = (await agent('GET', '/acceptCapacity')).json?.data?.capacity?.slotCapacity;
  if (offStatus?.enabled === false) {
    const o1 = await book('O1 off', { pDay: dayPlus(base + 2), pFrom: '18:00', pTo: '19:00', dDay: dayPlus(base + 8), dFrom: '18:00', dTo: '19:00' });
    const o2 = await book('O2 off', { pDay: dayPlus(base + 2), pFrom: '18:00', pTo: '19:00', dDay: dayPlus(base + 8), dFrom: '20:00', dTo: '21:00' });
    const r1 = await accept(o1);
    const r2 = await accept(o2);
    check('off', 'capacity off: first order in a pickup slot accepted', r1.status === 200, `${r1.status} ${r1.message}`);
    check('off', 'capacity off: second order in the same pickup slot refused (old 1-per-slot rule)', r2.status === 409 && /already have an order in this pickup or delivery slot/.test(r2.message), r2.message);
  } else {
    console.log(`SKIP [off] global capacity is ON (limit ${offStatus?.limit}); one-per-slot fallback not testable here`);
  }
}

async function cleanup() {
  if (policyBefore) {
    await setCap({
      acceptCapOverride: Boolean(policyBefore.acceptCapOverride),
      acceptMaxOrders: policyBefore.acceptMaxOrders ?? null,
      acceptWindowMinutes: policyBefore.acceptWindowMinutes ?? null,
    }).catch(() => {});
  }
  await models.booking.update(
    { bookingStatusId: 19 },
    { where: { customerId: CUST_ID, driverInstruction: { [Op.like]: `${PREFIX} ${RUN}%` } } }
  );
  if (redis) {
    await redis.hDel(`tsh${ADMIN_ID}`, 'slot-cap-admin');
    await redis.hDel(`id-${CUST_ID}`, 'slot-cap-cust');
    await redis.hDel(`id-${AGENT_ID}`, 'slot-cap-agent');
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

'use strict';

/**
 * Customer credit ledger against the local DB (positive and negative cases).
 * Uses synthetic customer/booking ids (no foreign keys on the ledger) and cleans up after itself.
 *   node tests/customerCredit.db.test.js
 */

const assert = require('assert');
const { customerCreditEntry: Entry, customerCreditAllocation: Allocation, sequelize } = require('../models');
const credit = require('../services/promotions/customerCreditService');

const BASE = 990000 + Math.floor(Math.random() * 9000);
let n = 0;
const nextCustomer = () => BASE * 10 + (++n);
const usedCustomers = [];
const customer = () => { const id = nextCustomer(); usedCustomers.push(id); return id; };
const booking = () => 8000000 + Math.floor(Math.random() * 999999);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name} — ${err.message}`);
  }
}
const bal = async (c) => (await credit.getBalance(c)).balance;

(async () => {
  await check('earn credits a lot; same booking + promotion again is idempotent', async () => {
    const c = customer();
    const b = booking();
    assert.strictEqual((await credit.earnCashback({ customerId: c, bookingId: b, promotionId: 1, amount: 10 })).created, true);
    assert.strictEqual((await credit.earnCashback({ customerId: c, bookingId: b, promotionId: 1, amount: 10 })).created, false);
    assert.strictEqual(await bal(c), 10);
    const lot = await Entry.findOne({ where: { customerId: c, type: 'EARN' } });
    assert.ok(lot.expiresAt, 'lot has an expiry');
    const days = (new Date(lot.expiresAt) - Date.now()) / 86400000;
    assert.ok(days > 364 && days <= 365.01, `expiry ~365 days, got ${days}`);
  });

  await check('earn of £0 or negative does nothing', async () => {
    const c = customer();
    assert.deepStrictEqual(await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 0 }), { entry: null, created: false });
    assert.deepStrictEqual(await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: -5 }), { entry: null, created: false });
    assert.strictEqual(await bal(c), 0);
  });

  await check('hold takes from balance; same amount again changes nothing; bigger re-price replaces the hold', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10 });
    const b = booking();
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 4 }), 4);
    assert.strictEqual(await bal(c), 6);
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 4 }), 4);
    assert.strictEqual(await Entry.count({ where: { bookingId: b, type: 'SPEND' } }), 1, 'no second spend row');
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 7 }), 7);
    assert.strictEqual(await bal(c), 3);
    const g = await credit.getBalance(c);
    assert.strictEqual(g.held, 7);
  });

  await check('hold is capped at the balance (never negative)', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10 });
    const b = booking();
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 25 }), 10);
    assert.strictEqual(await bal(c), 0);
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 5 }), 0, 'nothing left for another order');
  });

  await check('hold of 0 releases a previous hold', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10 });
    const b = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 6 });
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 0 }), 0);
    assert.strictEqual(await bal(c), 10);
  });

  await check('release (cancel) gives the credit back to the same lots', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10 });
    const b = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 8 });
    assert.strictEqual(await credit.releaseForBooking(b, 'Booking cancelled'), 1);
    assert.strictEqual(await bal(c), 10);
    assert.strictEqual(await credit.releaseForBooking(b), 0, 'second release is a no-op');
    // The booking can hold again after a release (key freed).
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 3 }), 3);
  });

  await check('commit freezes the spend: re-pricing a paid invoice does not change it', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10 });
    const b = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 6 });
    assert.strictEqual(await credit.commitForBooking(b), 1);
    assert.strictEqual(await credit.commitForBooking(b), 0, 'idempotent');
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 2 }), 6);
    assert.strictEqual(await credit.releaseForBooking(b), 0, 'a committed spend is not released');
    assert.strictEqual(await bal(c), 4);
    const s = await credit.spentOnBooking(b);
    assert.deepStrictEqual(s, { amount: 6, committed: true });
  });

  await check('full refund of an order paid with credit gives that credit back (once)', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10 });
    const b = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 6 });
    await credit.commitForBooking(b);
    assert.strictEqual(await credit.restoreSpendForBooking(b, 'refund'), 6);
    assert.strictEqual(await credit.restoreSpendForBooking(b, 'refund'), 0, 'idempotent');
    assert.strictEqual(await bal(c), 10);
  });

  await check('full refund of the cashback order takes back only the unspent part', async () => {
    const c = customer();
    const earnedOn = booking();
    await credit.earnCashback({ customerId: c, bookingId: earnedOn, promotionId: 1, amount: 10 });
    const b = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 4 });
    await credit.commitForBooking(b);
    assert.strictEqual(await credit.reverseCashbackForBooking(earnedOn, 'refund'), 6);
    assert.strictEqual(await credit.reverseCashbackForBooking(earnedOn, 'refund'), 0, 'idempotent');
    assert.strictEqual(await bal(c), 0, 'balance is 0, not negative');
  });

  await check('spending uses the lot that expires first', async () => {
    const c = customer();
    const { entry: later } = await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 5 });
    const { entry: sooner } = await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 2, amount: 5 });
    await sooner.update({ expiresAt: new Date(Date.now() + 5 * 86400000) });
    await credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 3 });
    await sooner.reload();
    await later.reload();
    assert.strictEqual(Number(sooner.remainingAmount), 2);
    assert.strictEqual(Number(later.remainingAmount), 5);
    const g = await credit.getBalance(c);
    assert.ok(g.expiringSoon && g.expiringSoon.amount === 2, 'expiring soon shows the 30-day lot');
  });

  await check('expired lots: not spendable, expired once, history shows it', async () => {
    const c = customer();
    const { entry: lot } = await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 7 });
    await lot.update({ expiresAt: new Date(Date.now() - 1000) });
    assert.strictEqual(await bal(c), 0);
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 5 }), 0);
    assert.ok((await credit.expireLots()) >= 1);
    await credit.expireLots();
    assert.strictEqual(await Entry.count({ where: { customerId: c, type: 'EXPIRE' } }), 1);
    const h = await credit.getHistory(c);
    assert.deepStrictEqual(h.entries.map((e) => e.type), ['EXPIRE', 'EARN']);
  });

  await check('admin adjust: add, remove, and refuse bad input', async () => {
    const c = customer();
    await credit.adjust({ customerId: c, amount: 5, reason: 'Goodwill', actorId: 1 });
    await credit.adjust({ customerId: c, amount: -3, reason: 'Mistake', actorId: 1 });
    assert.strictEqual(await bal(c), 2);
    await assert.rejects(credit.adjust({ customerId: c, amount: -5, reason: 'Too much', actorId: 1 }), /only has £2.00/);
    await assert.rejects(credit.adjust({ customerId: c, amount: 0, reason: 'x' }), /not be zero/);
    await assert.rejects(credit.adjust({ customerId: c, amount: 5, reason: '  ' }), /reason is required/);
    await assert.rejects(credit.adjust({ customerId: c, amount: 5000, reason: 'big' }), /£1,000 or less/);
    const key = `qa-adjust-${c}`;
    await credit.adjust({ customerId: c, amount: 1, reason: 'retry', idempotencyKey: key });
    await credit.adjust({ customerId: c, amount: 1, reason: 'retry', idempotencyKey: key });
    assert.strictEqual(await bal(c), 3, 'retried adjust counted once');
    const h = await credit.getHistory(c);
    assert.strictEqual(h.entries.find((e) => e.reason === 'Mistake').amount, -3);
  });

  await check('history hides released holds and shows held ones', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10 });
    const b1 = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b1, amount: 2 });
    await credit.releaseForBooking(b1);
    await credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 3 });
    const h = await credit.getHistory(c);
    assert.deepStrictEqual(h.entries.map((e) => `${e.type}:${e.status}`), ['SPEND:HELD', 'EARN:POSTED']);
    assert.strictEqual(h.entries[0].title, 'Held for order');
  });

  await check('concurrent holds on two orders never use more than the balance', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10 });
    const results = await Promise.allSettled([
      credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 8 }),
      credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 8 }),
      credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 8 }),
    ]);
    const held = results.filter((r) => r.status === 'fulfilled').reduce((s, r) => s + r.value, 0);
    assert.ok(held <= 10, `held ${held} > 10`);
    const g = await credit.getBalance(c);
    assert.strictEqual(Math.round((g.balance + g.held) * 100), 1000, 'balance + held = 10');
  });

  // Cleanup
  const ids = (await Entry.findAll({ where: { customerId: usedCustomers }, attributes: ['id'] })).map((e) => e.id);
  await Allocation.destroy({ where: { spendEntryId: ids } });
  await Entry.destroy({ where: { customerId: usedCustomers } });

  console.log(`\n${passed}/${passed + failed} passed`);
  await sequelize.close();
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('SCRIPT ERROR', err);
  process.exit(1);
});

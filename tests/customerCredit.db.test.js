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
    assert.strictEqual((await credit.earnCashback({ customerId: c, bookingId: b, promotionId: 1, amount: 10, currency: 'GBP' })).created, true);
    assert.strictEqual((await credit.earnCashback({ customerId: c, bookingId: b, promotionId: 1, amount: 10, currency: 'GBP' })).created, false);
    assert.strictEqual(await bal(c), 10);
    const lot = await Entry.findOne({ where: { customerId: c, type: 'EARN' } });
    assert.ok(lot.expiresAt, 'lot has an expiry');
    const days = (new Date(lot.expiresAt) - Date.now()) / 86400000;
    assert.ok(days > 364 && days <= 365.01, `expiry ~365 days, got ${days}`);
  });

  await check('earn of £0 or negative does nothing', async () => {
    const c = customer();
    assert.deepStrictEqual(await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 0, currency: 'GBP' }), { entry: null, created: false });
    assert.deepStrictEqual(await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: -5, currency: 'GBP' }), { entry: null, created: false });
    assert.strictEqual(await bal(c), 0);
  });

  await check('hold takes from balance; same amount again changes nothing; bigger re-price replaces the hold', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10, currency: 'GBP' });
    const b = booking();
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 4, currency: 'GBP' }), 4);
    assert.strictEqual(await bal(c), 6);
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 4, currency: 'GBP' }), 4);
    assert.strictEqual(await Entry.count({ where: { bookingId: b, type: 'SPEND' } }), 1, 'no second spend row');
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 7, currency: 'GBP' }), 7);
    assert.strictEqual(await bal(c), 3);
    const g = await credit.getBalance(c);
    assert.strictEqual(g.held, 7);
  });

  await check('hold is capped at the balance (never negative)', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10, currency: 'GBP' });
    const b = booking();
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 25, currency: 'GBP' }), 10);
    assert.strictEqual(await bal(c), 0);
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 5, currency: 'GBP' }), 0, 'nothing left for another order');
  });

  await check('hold of 0 releases a previous hold', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10, currency: 'GBP' });
    const b = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 6, currency: 'GBP' });
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 0, currency: 'GBP' }), 0);
    assert.strictEqual(await bal(c), 10);
  });

  await check('release (cancel) gives the credit back to the same lots', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10, currency: 'GBP' });
    const b = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 8, currency: 'GBP' });
    assert.strictEqual(await credit.releaseForBooking(b, 'Booking cancelled'), 1);
    assert.strictEqual(await bal(c), 10);
    assert.strictEqual(await credit.releaseForBooking(b), 0, 'second release is a no-op');
    // The booking can hold again after a release (key freed).
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 3, currency: 'GBP' }), 3);
  });

  await check('commit freezes the spend: re-pricing a paid invoice does not change it', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10, currency: 'GBP' });
    const b = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 6, currency: 'GBP' });
    assert.strictEqual(await credit.commitForBooking(b), 1);
    assert.strictEqual(await credit.commitForBooking(b), 0, 'idempotent');
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 2, currency: 'GBP' }), 6);
    assert.strictEqual(await credit.releaseForBooking(b), 0, 'a committed spend is not released');
    assert.strictEqual(await bal(c), 4);
    const s = await credit.spentOnBooking(b);
    assert.deepStrictEqual(s, { amount: 6, committed: true });
  });

  await check('full refund of an order paid with credit gives that credit back (once)', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10, currency: 'GBP' });
    const b = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 6, currency: 'GBP' });
    await credit.commitForBooking(b);
    assert.strictEqual(await credit.restoreSpendForBooking(b, 'refund'), 6);
    assert.strictEqual(await credit.restoreSpendForBooking(b, 'refund'), 0, 'idempotent');
    assert.strictEqual(await bal(c), 10);
  });

  await check('full refund of the cashback order takes back only the unspent part', async () => {
    const c = customer();
    const earnedOn = booking();
    await credit.earnCashback({ customerId: c, bookingId: earnedOn, promotionId: 1, amount: 10, currency: 'GBP' });
    const b = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 4, currency: 'GBP' });
    await credit.commitForBooking(b);
    assert.strictEqual(await credit.reverseCashbackForBooking(earnedOn, 'refund'), 6);
    assert.strictEqual(await credit.reverseCashbackForBooking(earnedOn, 'refund'), 0, 'idempotent');
    assert.strictEqual(await bal(c), 0, 'balance is 0, not negative');
  });

  await check('spending uses the lot that expires first', async () => {
    const c = customer();
    const { entry: later } = await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 5, currency: 'GBP' });
    const { entry: sooner } = await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 2, amount: 5, currency: 'GBP' });
    await sooner.update({ expiresAt: new Date(Date.now() + 5 * 86400000) });
    await credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 3, currency: 'GBP' });
    await sooner.reload();
    await later.reload();
    assert.strictEqual(Number(sooner.remainingAmount), 2);
    assert.strictEqual(Number(later.remainingAmount), 5);
    const g = await credit.getBalance(c);
    assert.ok(g.expiringSoon && g.expiringSoon.amount === 2, 'expiring soon shows the 30-day lot');
  });

  await check('expired lots: not spendable, expired once, history shows it', async () => {
    const c = customer();
    const { entry: lot } = await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 7, currency: 'GBP' });
    await lot.update({ expiresAt: new Date(Date.now() - 1000) });
    assert.strictEqual(await bal(c), 0);
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 5, currency: 'GBP' }), 0);
    assert.ok((await credit.expireLots()) >= 1);
    await credit.expireLots();
    assert.strictEqual(await Entry.count({ where: { customerId: c, type: 'EXPIRE' } }), 1);
    const h = await credit.getHistory(c);
    assert.deepStrictEqual(h.entries.map((e) => e.type), ['EXPIRE', 'EARN']);
  });

  await check('an invoice only spends credit in its own currency; entries need one', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10, currency: 'GBP' });
    assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 5, currency: 'USD' }), 0, 'GBP credit cannot pay a USD invoice');
    await assert.rejects(credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 5 }), /currency code is required/);
    await assert.rejects(credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 5 }), /currency code is required/);
    assert.strictEqual((await credit.getBalance(c)).currency, 'GBP');
    assert.strictEqual(await bal(c), 10);
  });

  await check('admin adjust: refused while the credit currency is unknown', async () => {
    const c = customer();
    // No credit and no address in a zone: no currency to adjust in (never a platform guess).
    await assert.rejects(credit.adjust({ customerId: c, amount: 5, reason: 'Goodwill' }), /currency is unknown/);
    assert.strictEqual((await credit.getBalance(c)).currency, null);
  });

  await check('admin adjust: add, remove, and refuse bad input', async () => {
    const c = customer();
    // The customer's credit is in GBP (an earlier order's), so adjustments are too.
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10, currency: 'GBP' });
    await credit.adjust({ customerId: c, amount: 5, reason: 'Goodwill', actorId: 1 });
    await credit.adjust({ customerId: c, amount: -3, reason: 'Mistake', actorId: 1 });
    assert.strictEqual(await bal(c), 12);
    assert.ok((await credit.getHistory(c)).entries.every((e) => e.currency === 'GBP'), 'adjustments in the credit currency');
    await assert.rejects(credit.adjust({ customerId: c, amount: -15, reason: 'Too much', actorId: 1 }), /only has £12.00/);
    await assert.rejects(credit.adjust({ customerId: c, amount: 0, reason: 'x' }), /not be zero/);
    await assert.rejects(credit.adjust({ customerId: c, amount: 5, reason: '  ' }), /reason is required/);
    await assert.rejects(credit.adjust({ customerId: c, amount: 5000, reason: 'big' }), /£1,000 or less/);
    const key = `qa-adjust-${c}`;
    await credit.adjust({ customerId: c, amount: 1, reason: 'retry', idempotencyKey: key });
    await credit.adjust({ customerId: c, amount: 1, reason: 'retry', idempotencyKey: key });
    assert.strictEqual(await bal(c), 13, 'retried adjust counted once');
    const h = await credit.getHistory(c);
    assert.strictEqual(h.entries.find((e) => e.reason === 'Mistake').amount, -3);
  });

  await check('history hides released holds and shows held ones', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10, currency: 'GBP' });
    const b1 = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b1, amount: 2, currency: 'GBP' });
    await credit.releaseForBooking(b1);
    await credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 3, currency: 'GBP' });
    const h = await credit.getHistory(c);
    assert.deepStrictEqual(h.entries.map((e) => `${e.type}:${e.status}`), ['SPEND:HELD', 'EARN:POSTED']);
    assert.strictEqual(h.entries[0].title, 'Held for order');
  });

  await check('concurrent holds on two orders never use more than the balance', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10, currency: 'GBP' });
    const results = await Promise.allSettled([
      credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 8, currency: 'GBP' }),
      credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 8, currency: 'GBP' }),
      credit.holdForBooking({ customerId: c, bookingId: booking(), amount: 8, currency: 'GBP' }),
    ]);
    const held = results.filter((r) => r.status === 'fulfilled').reduce((s, r) => s + r.value, 0);
    assert.ok(held <= 10, `held ${held} > 10`);
    const g = await credit.getBalance(c);
    assert.strictEqual(Math.round((g.balance + g.held) * 100), 1000, 'balance + held = 10');
  });

  // Production case (#1898): the invoice is priced twice in the same second while it already
  // holds the cashback. The second pricing used to release the hold without giving it back.
  await check('concurrent re-pricing of the same invoice never loses credit', async () => {
    for (let round = 0; round < 15; round++) {
      const c = customer();
      await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 4, currency: 'GBP' });
      const b = booking();
      assert.strictEqual(await credit.holdForBooking({ customerId: c, bookingId: b, amount: 30, currency: 'GBP' }), 4);
      await Promise.allSettled([
        credit.holdForBooking({ customerId: c, bookingId: b, amount: 30, currency: 'GBP' }),
        credit.holdForBooking({ customerId: c, bookingId: b, amount: 2, currency: 'GBP' }),
        credit.holdForBooking({ customerId: c, bookingId: b, amount: 30, currency: 'GBP' }),
      ]);
      const g = await credit.getBalance(c);
      assert.strictEqual(Math.round((g.balance + g.held) * 100), 400, `round ${round}: balance ${g.balance} + held ${g.held} != 4`);
    }
  });

  await check('re-pricing with the same payable amount keeps the hold as is', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 4, currency: 'GBP' });
    const b = booking();
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 30, currency: 'GBP' });
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 30, currency: 'GBP' });
    await credit.holdForBooking({ customerId: c, bookingId: b, amount: 28, currency: 'GBP' });
    const spends = await Entry.count({ where: { customerId: c, type: 'SPEND' } });
    assert.strictEqual(spends, 1, `expected 1 spend row, got ${spends}`);
  });

  await check('unused discount becomes credit once; history says Discount credit; full refund takes it back', async () => {
    const c = customer();
    const b = booking();
    assert.strictEqual((await credit.creditUnusedDiscount({ customerId: c, bookingId: b, promotionId: 7, amount: 2, currency: 'GBP' })).created, true);
    assert.strictEqual((await credit.creditUnusedDiscount({ customerId: c, bookingId: b, promotionId: 7, amount: 2, currency: 'GBP' })).created, false);
    assert.strictEqual(await bal(c), 2);
    const h = await credit.getHistory(c);
    assert.strictEqual(h.entries[0].title, 'Discount credit');
    assert.strictEqual((await credit.creditUnusedDiscount({ customerId: c, bookingId: b, promotionId: 8, amount: 0, currency: 'GBP' })).created, false);
    assert.strictEqual(await credit.reverseCashbackForBooking(b, 'test refund'), 2);
    assert.strictEqual(await bal(c), 0);
  });

  await check('support adjustments are not taken back by an order refund', async () => {
    const c = customer();
    await credit.earnCashback({ customerId: c, bookingId: booking(), promotionId: 1, amount: 10, currency: 'GBP' });
    await credit.adjust({ customerId: c, amount: 5, reason: 'goodwill' });
    assert.strictEqual(await credit.reverseCashbackForBooking(booking(), 'test refund'), 0);
    assert.strictEqual(await bal(c), 15);
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

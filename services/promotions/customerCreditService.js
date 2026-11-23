'use strict';

/**
 * Customer credit ledger: cashback is paid as in-app credit (docs/CASHBACK_CREDIT_PLAN.md).
 *
 * Lots (EARN, RESTORE, positive ADJUST) carry `remainingAmount` and `expiresAt`. Spending takes
 * from the lots that expire first and records allocations, so releasing a hold puts the money
 * back in the same lots. Balance = remaining of live lots; it never goes negative.
 *
 * SPEND: HELD (invoice priced) → COMMITTED (invoice paid) | RELEASED (cancelled / re-priced).
 * Every write locks the customer's lots, and every movement has a unique idempotency key.
 *
 * Currency: every entry stores its own. Credit earned on an order is in that order's
 * currency (its redemption's / zone's); a reversal, restore or expiry is in the currency
 * of the entry it moves; an invoice only spends lots in its own currency. Admin
 * adjustments use the customer's credit currency (see customerCreditCurrency). Nothing
 * falls back to a platform currency.
 */

const { Op } = require('sequelize');
const {
  customerCreditEntry: Entry,
  customerCreditAllocation: Allocation,
  sequelize,
} = require('../../models');
const { toMinor, fromMinor } = require('./moneyUtils');
const { zoneCurrency } = require('../../utils/zoneCurrency');
const { warmCurrencySymbols, currencySymbolOf } = require('../../utils/currencySymbols');
const { currencyOfCode } = require('../../utils/resolveDisplayCurrency');
const { requireCurrencyCode } = require('../../utils/requireCurrency');
const { ValidationError } = require('../../middlewares/universalErrorHandler');

const DAY_MS = 24 * 60 * 60 * 1000;
const LOT_TYPES = ['EARN', 'RESTORE', 'ADJUST'];
const DEFAULT_EXPIRY_DAYS = 365;

const keys = {
  cashback: (bookingId, promotionId) => `cashback-booking-${bookingId}-promo-${promotionId}`,
  spend: (bookingId) => `spend-booking-${bookingId}`,
  reverse: (lotId) => `reverse-lot-${lotId}`,
  restore: (spendId) => `restore-spend-${spendId}`,
  expire: (lotId) => `expire-lot-${lotId}`,
  discountCredit: (bookingId, promotionId) => `discount-credit-booking-${bookingId}-promo-${promotionId}`,
};

/** Days until new credit expires: CUSTOMER_CREDIT_EXPIRY_DAYS, 0 = never. */
function expiryDays(env = process.env) {
  const raw = env.CUSTOMER_CREDIT_EXPIRY_DAYS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_EXPIRY_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_EXPIRY_DAYS;
}

function expiresAtFrom(now = new Date()) {
  const days = expiryDays();
  return days ? new Date(now.getTime() + days * DAY_MS) : null;
}

function inTransaction(fn, outer) {
  if (outer) return fn(outer);
  return sequelize.transaction((t) => fn(t));
}

const liveLotWhere = (customerId, now, currency) => ({
  customerId,
  type: LOT_TYPES,
  ...(currency ? { currency } : {}),
  remainingAmount: { [Op.gt]: 0 },
  [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: now } }],
});

/** The customer's live lots (in `currency`, when given), soonest expiry first, locked. */
async function lockLots(customerId, t, currency = null, now = new Date()) {
  return Entry.findAll({
    where: liveLotWhere(customerId, now, currency),
    order: [[sequelize.literal('expiresAt IS NULL'), 'ASC'], ['expiresAt', 'ASC'], ['id', 'ASC']],
    lock: t.LOCK.UPDATE,
    transaction: t,
  });
}

/**
 * Lock every credit lot of the customer (spent or not) for this transaction. Credit changes of
 * one customer then run one at a time: a parallel re-pricing of the same invoice waits here
 * instead of acting on rows it read before the other one committed (that lost credit).
 */
async function lockCustomerLots(customerId, t) {
  if (!customerId) return;
  await Entry.findAll({
    where: { customerId, type: LOT_TYPES },
    attributes: ['id'],
    order: [['id', 'ASC']],
    lock: t.LOCK.UPDATE,
    transaction: t,
  });
}

/** Take up to amountMinor from the lots (FIFO), recording allocations against entry. */
async function allocateFromLots(lots, entry, amountMinor, t) {
  let left = amountMinor;
  for (const lot of lots) {
    if (left <= 0) break;
    const available = toMinor(lot.remainingAmount);
    const take = Math.min(available, left);
    if (take <= 0) continue;
    await lot.update({ remainingAmount: fromMinor(available - take) }, { transaction: t });
    await Allocation.create({ spendEntryId: entry.id, lotEntryId: lot.id, amount: fromMinor(take) }, { transaction: t });
    left -= take;
  }
  return amountMinor - left;
}

/** Put a spend's allocations back into their lots. */
async function restoreAllocations(entry, t) {
  // Locking read: always the latest rows, never an older snapshot of this transaction.
  const allocations = await Allocation.findAll({ where: { spendEntryId: entry.id }, lock: t.LOCK.UPDATE, transaction: t });
  for (const a of allocations) {
    const lot = await Entry.findByPk(a.lotEntryId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!lot) continue;
    await lot.update({ remainingAmount: fromMinor(toMinor(lot.remainingAmount) + toMinor(a.amount)) }, { transaction: t });
  }
  return allocations.length;
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * ISO code the customer's credit is kept and spent in: their default address zone's
 * currency (what their orders are priced in), else their latest credit's. Null when
 * neither exists — the currency is then unknown, never a platform guess.
 */
async function customerCreditCurrency(customerId, transaction) {
  // The currency the customer's orders are priced in: their default address zone's;
  // else (no address yet) their latest credit's; null when neither exists.
  const { addressDb } = require('../../models');
  const address = await addressDb.findOne({
    where: { userId: customerId, isDefault: true },
    attributes: ['id', 'zoneId'],
    order: [['id', 'DESC']],
    transaction,
  });
  const zoneCode = address?.zoneId ? (await zoneCurrency(address.zoneId)).currencyCode : '';
  if (zoneCode) return String(zoneCode).toUpperCase();
  const latest = await Entry.findOne({
    where: { customerId },
    attributes: ['currency'],
    order: [['id', 'DESC']],
    transaction,
  });
  return latest?.currency ? String(latest.currency).toUpperCase() : null;
}

/**
 * Credit per currency — credit only pays invoices in its own currency, so amounts in
 * different currencies are never added together.
 *
 * Top level = the customer's spendable currency (their default address zone's, else
 * their latest credit's): { currency, currencySymbol, balance, held, expiringSoon }.
 * `balances` lists every currency the customer holds credit in (same fields), so
 * credit left in another zone's currency stays visible. held = on unpaid invoices.
 */
async function getBalance(customerId, now = new Date()) {
  const [lots, held] = await Promise.all([
    Entry.findAll({
      where: liveLotWhere(customerId, now),
      attributes: ['remainingAmount', 'expiresAt', 'currency'],
      order: [[sequelize.literal('expiresAt IS NULL'), 'ASC'], ['expiresAt', 'ASC']],
    }),
    Entry.findAll({ where: { customerId, type: 'SPEND', status: 'HELD' }, attributes: ['amount', 'currency'] }),
  ]);
  await warmCurrencySymbols();
  const soonLimit = new Date(now.getTime() + 30 * DAY_MS);
  const code = (c) => (c ? String(c).toUpperCase() : null);

  const byCurrency = new Map();
  const bucket = (c) => {
    if (!byCurrency.has(c)) byCurrency.set(c, { lots: [], heldMinor: 0 });
    return byCurrency.get(c);
  };
  for (const lot of lots) bucket(code(lot.currency)).lots.push(lot);
  for (const e of held) bucket(code(e.currency)).heldMinor += Math.abs(toMinor(e.amount));

  const summarize = (currency) => {
    const b = byCurrency.get(currency) || { lots: [], heldMinor: 0 };
    const soon = b.lots.filter((l) => l.expiresAt && new Date(l.expiresAt) <= soonLimit);
    return {
      currency,
      currencySymbol: currency ? currencySymbolOf(currency) : null,
      balance: fromMinor(b.lots.reduce((s, l) => s + toMinor(l.remainingAmount), 0)),
      held: fromMinor(b.heldMinor),
      expiringSoon: soon.length
        ? { amount: fromMinor(soon.reduce((s, l) => s + toMinor(l.remainingAmount), 0)), expiresAt: soon[0].expiresAt }
        : null,
    };
  };

  const spendable = code(await customerCreditCurrency(customerId));
  return {
    ...summarize(spendable),
    balances: [...byCurrency.keys()].map(summarize),
  };
}

const HISTORY_TEXT = {
  EARN: 'Cashback',
  RESTORE: 'Credit returned',
  ADJUST: 'Adjustment',
  SPEND: 'Used on order',
  REVERSE: 'Cashback taken back',
  EXPIRE: 'Expired',
};

/** Ledger lines for the customer, newest first. Released holds are hidden (nothing moved). */
async function getHistory(customerId, { page = 1, limit = 20 } = {}) {
  const size = Math.min(100, Math.max(1, Number(limit) || 20));
  const offset = (Math.max(1, Number(page) || 1) - 1) * size;
  const { rows, count } = await Entry.findAndCountAll({
    where: { customerId, [Op.not]: { type: 'SPEND', status: 'RELEASED' } },
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: size,
    offset,
  });
  return {
    total: count,
    page: Math.max(1, Number(page) || 1),
    limit: size,
    entries: rows.map((e) => ({
      id: e.id,
      type: e.type,
      status: e.status,
      title: e.type === 'SPEND' && e.status === 'HELD' ? 'Held for order'
        : isDiscountCredit(e) ? 'Discount credit'
          : HISTORY_TEXT[e.type],
      description: e.description || null,
      amount: Number(e.amount),
      currency: e.currency,
      remainingAmount: e.remainingAmount != null ? Number(e.remainingAmount) : null,
      expiresAt: e.expiresAt,
      bookingId: e.bookingId,
      promotionId: e.promotionId,
      reason: e.actorType === 'admin' ? e.reason : null,
      createdAt: e.createdAt,
    })),
  };
}

/** Credit used on a booking's invoice (held or committed), positive, in its currency. */
async function spentOnBooking(bookingId, transaction) {
  const rows = await Entry.findAll({
    where: { bookingId, type: 'SPEND', status: ['HELD', 'COMMITTED'] },
    attributes: ['amount', 'status'],
    transaction,
  });
  return {
    amount: fromMinor(rows.reduce((s, e) => s + Math.abs(toMinor(e.amount)), 0)),
    committed: rows.some((e) => e.status === 'COMMITTED'),
  };
}

// ─── Earn ───────────────────────────────────────────────────────────────────

/**
 * Credit a cashback lot. Idempotent per booking + promotion.
 * @returns {{ entry: object|null, created: boolean }}
 */
async function earnCashback({ customerId, bookingId, promotionId, redemptionId = null, amount, currency, description }, transaction) {
  const amountMinor = toMinor(amount);
  if (!customerId || amountMinor <= 0) return { entry: null, created: false };
  const code = requireCurrencyCode(currency, 'earnCashback');
  return inTransaction(async (t) => {
    const idempotencyKey = keys.cashback(bookingId, promotionId);
    const existing = await Entry.findOne({ where: { idempotencyKey }, transaction: t });
    if (existing) return { entry: existing, created: false };
    const entry = await Entry.create({
      customerId,
      type: 'EARN',
      status: 'POSTED',
      amount: fromMinor(amountMinor),
      remainingAmount: fromMinor(amountMinor),
      currency: code,
      expiresAt: expiresAtFrom(),
      bookingId,
      promotionId,
      redemptionId,
      idempotencyKey,
      description: description || `Cashback from order #${bookingId}`,
      actorType: 'system',
    }, { transaction: t });
    return { entry, created: true };
  }, transaction);
}

/**
 * Credit the part of a promotion's discount the invoice could not take (a card order already
 * paid at booking covered the bill). A system ADJUST lot, so cashback reports stay cashback only.
 * Idempotent per booking + promotion. Taken back on a full refund, like cashback.
 * @returns {{ entry: object|null, created: boolean }}
 */
async function creditUnusedDiscount({ customerId, bookingId, promotionId, amount, currency, description }, transaction) {
  const amountMinor = toMinor(amount);
  if (!customerId || !bookingId || amountMinor <= 0) return { entry: null, created: false };
  const code = requireCurrencyCode(currency, 'creditUnusedDiscount');
  return inTransaction(async (t) => {
    const idempotencyKey = keys.discountCredit(bookingId, promotionId);
    const existing = await Entry.findOne({ where: { idempotencyKey }, transaction: t });
    if (existing) return { entry: existing, created: false };
    const entry = await Entry.create({
      customerId,
      type: 'ADJUST',
      status: 'POSTED',
      amount: fromMinor(amountMinor),
      remainingAmount: fromMinor(amountMinor),
      currency: code,
      expiresAt: expiresAtFrom(),
      bookingId,
      promotionId,
      idempotencyKey,
      description: description || `Unused discount from order #${bookingId}`,
      actorType: 'system',
    }, { transaction: t });
    return { entry, created: true };
  }, transaction);
}

const isDiscountCredit = (e) => String(e?.idempotencyKey || '').startsWith('discount-credit-');

// ─── Spend on an invoice ────────────────────────────────────────────────────

/**
 * Hold up to `amount` of the customer's credit against a booking's unpaid invoice.
 * The hold is min(amount, credit available incl. this hold); an unchanged hold is kept as is,
 * a changed one is replaced. A paid (committed) spend is frozen and returned as is.
 * `currency` is the booking's (its zone's): only lots in it can pay the invoice.
 * @returns {number} the credit now held (in that currency)
 */
async function holdForBooking({ customerId, bookingId, amount, currency: bookingCurrency }, transaction) {
  const currency = requireCurrencyCode(bookingCurrency, `holdForBooking(booking ${bookingId})`);
  return inTransaction(async (t) => {
    await lockCustomerLots(customerId, t);
    const committed = await Entry.findOne({ where: { bookingId, type: 'SPEND', status: 'COMMITTED' }, lock: t.LOCK.UPDATE, transaction: t });
    if (committed) return Math.abs(Number(committed.amount));

    const existing = await Entry.findOne({ where: { bookingId, type: 'SPEND', status: 'HELD' }, lock: t.LOCK.UPDATE, transaction: t });
    const existingMinor = existing ? toMinor(Math.abs(Number(existing.amount))) : 0;
    const wantMinor = Math.max(0, toMinor(amount));
    const live = customerId ? await lockLots(customerId, t, currency) : [];
    const targetMinor = customerId
      ? Math.min(wantMinor, live.reduce((s, l) => s + toMinor(l.remainingAmount), 0) + existingMinor)
      : 0;
    // Same hold as before: nothing moves (re-pricing used to release and re-hold every time).
    if (existing && existingMinor === targetMinor) return fromMinor(targetMinor);
    if (existing) await releaseEntry(existing, 'Invoice re-priced', t);
    if (targetMinor <= 0) return 0;

    // Read again after the release above, which may have refilled them.
    const fresh = await lockLots(customerId, t, currency);
    const availableMinor = fresh.reduce((s, l) => s + toMinor(l.remainingAmount), 0);
    const takeMinor = Math.min(targetMinor, availableMinor);
    if (takeMinor <= 0) return 0;

    const entry = await Entry.create({
      customerId,
      type: 'SPEND',
      status: 'HELD',
      amount: -fromMinor(takeMinor),
      currency,
      bookingId,
      idempotencyKey: keys.spend(bookingId),
      description: `Used on order #${bookingId}`,
      actorType: 'system',
    }, { transaction: t });
    await allocateFromLots(fresh, entry, takeMinor, t);
    return fromMinor(takeMinor);
  }, transaction);
}

async function releaseEntry(entry, reason, t) {
  await restoreAllocations(entry, t);
  await entry.update({
    status: 'RELEASED',
    reason: reason || 'Released',
    // Free the key so the booking can hold credit again later.
    idempotencyKey: entry.idempotencyKey ? `${entry.idempotencyKey}:released:${entry.id}` : null,
  }, { transaction: t });
}

/** The invoice no longer uses credit (cancelled, flag off, re-priced to 0): give it back. */
async function releaseForBooking(bookingId, reason, transaction) {
  if (!bookingId) return 0;
  return inTransaction(async (t) => {
    // Same lock order as holdForBooking: the customer's lots first, then the spend rows.
    const owners = await Entry.findAll({ where: { bookingId, type: 'SPEND', status: 'HELD' }, attributes: ['customerId'], transaction: t });
    for (const customerId of [...new Set(owners.map((o) => o.customerId))]) await lockCustomerLots(customerId, t);
    const held = await Entry.findAll({ where: { bookingId, type: 'SPEND', status: 'HELD' }, lock: t.LOCK.UPDATE, transaction: t });
    for (const e of held) await releaseEntry(e, reason || 'Booking cancelled', t);
    return held.length;
  }, transaction);
}

/** The invoice is paid: the held credit is spent for good. Idempotent. */
async function commitForBooking(bookingId, transaction) {
  if (!bookingId) return 0;
  const [count] = await Entry.update(
    { status: 'COMMITTED' },
    { where: { bookingId, type: 'SPEND', status: 'HELD' }, transaction }
  );
  return count;
}

// ─── Refunds ────────────────────────────────────────────────────────────────

/**
 * Full refund of an order that earned cashback: take back what is still unspent of that
 * cashback. A part already spent is not clawed back (the balance never goes negative).
 */
async function reverseCashbackForBooking(bookingId, reason, transaction) {
  if (!bookingId) return 0;
  return inTransaction(async (t) => {
    // Cashback lots and unused-discount credit of this order.
    const lots = (await Entry.findAll({ where: { bookingId, type: ['EARN', 'ADJUST'] }, lock: t.LOCK.UPDATE, transaction: t }))
      .filter((lot) => lot.type === 'EARN' || isDiscountCredit(lot));
    let reversedMinor = 0;
    for (const lot of lots) {
      const idempotencyKey = keys.reverse(lot.id);
      if (await Entry.findOne({ where: { idempotencyKey }, transaction: t })) continue;
      const leftMinor = toMinor(lot.remainingAmount);
      await Entry.create({
        customerId: lot.customerId,
        type: 'REVERSE',
        status: 'POSTED',
        amount: -fromMinor(leftMinor),
        currency: lot.currency,
        bookingId,
        promotionId: lot.promotionId,
        sourceEntryId: lot.id,
        idempotencyKey,
        description: isDiscountCredit(lot)
          ? `Discount credit from order #${bookingId} taken back (order refunded)`
          : `Cashback from order #${bookingId} taken back (order refunded)`,
        reason: reason || 'Booking refunded',
        actorType: 'system',
      }, { transaction: t });
      await lot.update({ remainingAmount: 0 }, { transaction: t });
      reversedMinor += leftMinor;
    }
    return fromMinor(reversedMinor);
  }, transaction);
}

/** Full refund of an order paid partly with credit: give that credit back as a new lot. */
async function restoreSpendForBooking(bookingId, reason, transaction) {
  if (!bookingId) return 0;
  return inTransaction(async (t) => {
    const spends = await Entry.findAll({ where: { bookingId, type: 'SPEND', status: 'COMMITTED' }, lock: t.LOCK.UPDATE, transaction: t });
    let restoredMinor = 0;
    for (const s of spends) {
      const idempotencyKey = keys.restore(s.id);
      if (await Entry.findOne({ where: { idempotencyKey }, transaction: t })) continue;
      const amountMinor = Math.abs(toMinor(s.amount));
      await Entry.create({
        customerId: s.customerId,
        type: 'RESTORE',
        status: 'POSTED',
        amount: fromMinor(amountMinor),
        remainingAmount: fromMinor(amountMinor),
        currency: s.currency,
        expiresAt: expiresAtFrom(),
        bookingId,
        sourceEntryId: s.id,
        idempotencyKey,
        description: `Credit returned from refunded order #${bookingId}`,
        reason: reason || 'Booking refunded',
        actorType: 'system',
      }, { transaction: t });
      restoredMinor += amountMinor;
    }
    return fromMinor(restoredMinor);
  }, transaction);
}

// ─── Expiry ─────────────────────────────────────────────────────────────────

/** Expire the unspent part of lots past their expiry date. Idempotent per lot. */
async function expireLots({ now = new Date(), limit = 500 } = {}) {
  const due = await Entry.findAll({
    where: { type: LOT_TYPES, remainingAmount: { [Op.gt]: 0 }, expiresAt: { [Op.lte]: now } },
    attributes: ['id'],
    limit,
  });
  let expired = 0;
  for (const { id } of due) {
    try {
      await sequelize.transaction(async (t) => {
        const lot = await Entry.findByPk(id, { lock: t.LOCK.UPDATE, transaction: t });
        const leftMinor = toMinor(lot?.remainingAmount);
        if (!lot || leftMinor <= 0) return;
        const idempotencyKey = keys.expire(lot.id);
        if (await Entry.findOne({ where: { idempotencyKey }, transaction: t })) return;
        await Entry.create({
          customerId: lot.customerId,
          type: 'EXPIRE',
          status: 'POSTED',
          amount: -fromMinor(leftMinor),
          currency: lot.currency,
          sourceEntryId: lot.id,
          bookingId: lot.bookingId,
          idempotencyKey,
          description: 'Credit expired',
          actorType: 'system',
        }, { transaction: t });
        await lot.update({ remainingAmount: 0 }, { transaction: t });
        expired++;
      });
    } catch (err) {
      console.warn(`[customerCredit] expire lot ${id} failed:`, err.message);
    }
  }
  return expired;
}

// ─── Admin ──────────────────────────────────────────────────────────────────

/** Most credit support can add or remove in one adjustment, in the credit's currency. */
const MAX_ADJUST_MINOR = 100000;

/**
 * Admin adds (+) or removes (−) credit, with a reason, in the customer's credit currency
 * (customerCreditCurrency). Removing never takes more than the customer has in it.
 * Optional idempotencyKey makes a retried request safe.
 */
async function adjust({ customerId, amount, reason, actorId = null, idempotencyKey = null }, transaction) {
  if (!Number.isFinite(Number(amount))) throw new ValidationError('Amount must be a number');
  const amountMinor = toMinor(amount);
  const why = String(reason || '').trim().slice(0, 500);
  if (!customerId) throw new ValidationError('customerId is required');
  if (!amountMinor) throw new ValidationError('Amount must not be zero');
  if (!why) throw new ValidationError('A reason is required');
  const code = await customerCreditCurrency(customerId, transaction);
  if (!code) {
    throw new ValidationError(
      "This customer has no credit and no default address in a zone yet, so the credit's currency is unknown. Add an address first."
    );
  }
  const { currencySymbol } = await currencyOfCode(code);
  if (Math.abs(amountMinor) > MAX_ADJUST_MINOR) {
    throw new ValidationError(`Amount must be ${currencySymbol}${fromMinor(MAX_ADJUST_MINOR).toLocaleString('en-GB')} or less`);
  }
  return inTransaction(async (t) => {
    if (idempotencyKey) {
      const existing = await Entry.findOne({ where: { idempotencyKey }, transaction: t });
      if (existing) return existing;
    }
    if (amountMinor > 0) {
      return Entry.create({
        customerId,
        type: 'ADJUST',
        status: 'POSTED',
        amount: fromMinor(amountMinor),
        remainingAmount: fromMinor(amountMinor),
        currency: code,
        expiresAt: expiresAtFrom(),
        idempotencyKey,
        description: 'Credit added by support',
        reason: why,
        actorId,
        actorType: 'admin',
      }, { transaction: t });
    }
    const lots = await lockLots(customerId, t, code);
    const availableMinor = lots.reduce((s, l) => s + toMinor(l.remainingAmount), 0);
    if (-amountMinor > availableMinor) {
      throw new ValidationError(`The customer only has ${currencySymbol}${fromMinor(availableMinor).toFixed(2)} credit to remove`);
    }
    const entry = await Entry.create({
      customerId,
      type: 'ADJUST',
      status: 'POSTED',
      amount: fromMinor(amountMinor),
      currency: code,
      idempotencyKey,
      description: 'Credit removed by support',
      reason: why,
      actorId,
      actorType: 'admin',
    }, { transaction: t });
    await allocateFromLots(lots, entry, -amountMinor, t);
    return entry;
  }, transaction);
}

module.exports = {
  LOT_TYPES,
  keys,
  expiryDays,
  getBalance,
  customerCreditCurrency,
  getHistory,
  spentOnBooking,
  earnCashback,
  creditUnusedDiscount,
  holdForBooking,
  releaseForBooking,
  commitForBooking,
  reverseCashbackForBooking,
  restoreSpendForBooking,
  expireLots,
  adjust,
};

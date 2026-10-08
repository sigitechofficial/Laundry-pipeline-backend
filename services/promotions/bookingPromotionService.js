'use strict';

/**
 * Promotions at booking (docs/PROMOTIONS_CHECKOUT_PLAN.md, Phase 2).
 *
 * At booking we only know who, where, when and how they pay, so a booking checks
 * eligibility and holds (reserves) the promotions it may use. The money is decided
 * at invoice, on the real laundry items, like legacy coupons.
 *
 * Everything here is behind PROMOTIONS_CHECKOUT_ENABLED (checkoutFlag.js). A code
 * lives in one system only (Promotions or Coupons (Legacy)), so a code found in
 * coupon_codes goes to Promotions and anything else stays on the legacy path.
 */

const {
  couponCode: CouponCode,
  booking: Booking,
  promotionRedemption: Redemption,
  orderAdjustment: OrderAdjustment,
  customerSelectedService: CustomerSelectedService,
  customerSelectedServiceAddOn: CustomerSelectedServiceAddOn,
} = require('../../models');
const { ValidationError } = require('../../middlewares/universalErrorHandler');
const { CUSTOMER_RESERVE_MESSAGE } = require('../../utils/couponDiscount');
const { normalizePaymentType } = require('../../utils/invoicePaymentSummary');
const { isPromotionsCheckoutEnabled } = require('./checkoutFlag');
const { buildPromotionContext } = require('./contextBuilder');
const { evaluateBookingEligibility, buildOfferLabel, evaluatePromotions, loadHeldPromotions } = require('./promotionEngine');
const { effectiveValues, resolveDiscountMode } = require('./benefitHandlers');
const { toMinor, fromMinor, allocateMinor } = require('./moneyUtils');
const ledger = require('./redemptionService');

const normalizeCode = (code) => String(code ?? '').trim().toUpperCase();

/** Does this code belong to Promotions? */
async function isPromotionCode(code) {
  const c = normalizeCode(code);
  if (!c) return false;
  return Boolean(await CouponCode.findOne({ where: { code: c }, attributes: ['id'] }));
}

/** Route a customer's code to Promotions only when the flag is on for the zone. */
async function usesPromotionCode(code, zoneId) {
  if (!normalizeCode(code) || !isPromotionsCheckoutEnabled(zoneId)) return false;
  return isPromotionCode(code);
}

function bookingContext({ zoneId, customerId, couponCode, paymentType, collectionDate, deliveryDate, excludeBookingId }) {
  return buildPromotionContext({
    zoneId,
    customerId,
    couponCodes: normalizeCode(couponCode) ? [couponCode] : [],
    paymentMethod: paymentType || null,
    collectionDate: collectionDate || null,
    deliveryDate: deliveryDate || null,
    customerAsOf: excludeBookingId ? { excludeBookingId } : {},
  });
}

const zoneOverrideOf = (promo, zoneId) =>
  (promo.zoneOverrides || []).find((zo) => Number(zo.zoneId) === Number(zoneId) && zo.isActive !== false) || null;

function zoneIdsOf(promo) {
  const raw = promo.zoneIds;
  const list = Array.isArray(raw) ? raw : (() => { try { return JSON.parse(raw || '[]'); } catch { return []; } })();
  return (list || []).map(Number).filter(Boolean);
}

/**
 * Checkout code check for a Promotions code. Returns the same shape as the legacy
 * couponService.validateCoupon, so POST /customer/applyCoupon and installed apps keep
 * working. Throws ValidationError with a customer-facing message, like legacy.
 */
async function validateCodeForCheckout({ code, customerId, zoneId, laundryCartAmount = 0, paymentType, collectionDate, deliveryDate }) {
  if (zoneId == null || zoneId === '') {
    throw new ValidationError('Choose a collection address in a valid zone to use this code.');
  }
  const context = await bookingContext({ zoneId, customerId, couponCode: code, paymentType, collectionDate, deliveryDate });
  const { eligible, rejected, couponErrors } = await evaluateBookingEligibility(context);
  if (couponErrors.length) throw new ValidationError(couponErrors[0].message);

  const normalized = normalizeCode(code);
  const hit = eligible.find((e) => e.coupon && normalizeCode(e.coupon.code) === normalized);
  if (!hit) {
    const why = rejected.find((r) => r.coupon && normalizeCode(r.coupon.code) === normalized);
    throw new ValidationError(why?.reasons?.[0]?.reason || 'This code cannot be used for this booking');
  }

  const promo = hit.promotion;
  const zoneOverride = zoneOverrideOf(promo, zoneId);
  const values = effectiveValues(promo, zoneOverride);
  const ids = zoneIdsOf(promo);
  const label = buildOfferLabel(promo, zoneOverride);
  const laundry = Number(laundryCartAmount) || 0;
  return {
    couponId: promo.id,
    promotionId: promo.id,
    discountAmt: 0,
    finalAmount: laundry,
    laundryCartAmount: laundry,
    minOrderAmount: values.minSubtotal != null && values.minSubtotal > 0 ? values.minSubtotal : null,
    minOrderDeferred: true,
    appliesAt: 'invoice',
    appliesTo: 'laundry',
    prepaidUnchanged: true,
    zoneScope: promo.zoneScopeMode === 'all' || !ids.length ? 'all' : 'specific',
    zoneIds: ids,
    offerLabel: label,
    customerMessage: `${label}. ${CUSTOMER_RESERVE_MESSAGE}`,
    couponData: {
      code: hit.coupon.code,
      discountType: resolveDiscountMode(promo) === 'percent' ? 'percentage' : 'flat',
      discountValue: values.discountValue,
    },
  };
}

/**
 * After the booking row exists: hold every promotion it may use (the entered code's
 * promotion plus automatic ones). One promotion failing to reserve (limit just reached)
 * never blocks the booking; it is logged and skipped.
 */
async function attachAtBooking({ bookingId, customerId, zoneId, couponCode, paymentType, collectionDate, deliveryDate }) {
  if (!bookingId || !isPromotionsCheckoutEnabled(zoneId)) return { reserved: [], skipped: [] };
  const code = (await usesPromotionCode(couponCode, zoneId)) ? couponCode : null;
  const context = await bookingContext({ zoneId, customerId, couponCode: code, paymentType, collectionDate, deliveryDate, excludeBookingId: bookingId });
  const { eligible } = await evaluateBookingEligibility(context);

  const reserved = [];
  const skipped = [];
  for (const { promotion, coupon } of eligible) {
    try {
      const row = await ledger.reserveRedemption({
        promotionId: promotion.id,
        customerId,
        couponCode: coupon?.code || null,
        zoneId,
        bookingId,
        idempotencyKey: ledger.bookingReservationKey(bookingId, promotion.id),
      });
      reserved.push(row.id);
    } catch (err) {
      skipped.push({ promotionId: promotion.id, reason: err.code || err.message });
    }
  }
  if (skipped.length) console.warn(`[promotions] booking ${bookingId}: promotions not held`, skipped);
  return { reserved, skipped };
}

/** Booking did not go ahead (card hold failed, cancelled before payment): give the holds back. */
async function releaseForBooking(bookingId, reason) {
  if (!bookingId) return 0;
  try {
    return await ledger.releaseBookingRedemptions(bookingId, reason);
  } catch (err) {
    console.error(`[promotions] booking ${bookingId}: release failed`, err.message);
    return 0;
  }
}

// ─── Invoice (Phase 3) ──────────────────────────────────────────────────────

const PROMOTION_ADJUSTMENT_CLASSES = ['ITEM_PROMOTION', 'BASKET_PROMOTION', 'DELIVERY_PROMOTION'];
const roundMoney = (n) => fromMinor(toMinor(n));

/** Promotion discount already written on the booking (positive £). */
async function storedPromotionDiscount(bookingId) {
  const rows = await OrderAdjustment.findAll({
    where: { bookingId, appliedBy: 'system', adjustmentClass: PROMOTION_ADJUSTMENT_CLASSES, reversedAt: null },
    attributes: ['amount'],
  });
  return roundMoney(rows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0));
}

/** The invoice's active laundry lines in engine form (same rows/prices as sumActiveBookingServicesSubtotal). */
async function invoiceLineItems(bookingId) {
  const rows = await CustomerSelectedService.findAll({
    where: { bookingId, status: true },
    attributes: ['id', 'serviceId', 'categoryId', 'subCategoryId', 'categoryPrice', 'items'],
    include: [{ model: CustomerSelectedServiceAddOn, as: 'addOns', attributes: ['addOnServiceId', 'price', 'items'] }],
  });
  const qtyOf = (items) => {
    const n = parseInt(items, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  };
  const priceOf = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const lines = [];
  for (const row of rows) {
    const ids = {
      serviceId: row.serviceId != null ? Number(row.serviceId) : null,
      categoryId: row.categoryId != null ? Number(row.categoryId) : null,
    };
    lines.push({ ...ids, subCategoryId: row.subCategoryId != null ? Number(row.subCategoryId) : null, addonId: null, price: priceOf(row.categoryPrice), qty: qtyOf(row.items) });
    for (const addOn of row.addOns || []) {
      lines.push({ ...ids, subCategoryId: null, addonId: Number(addOn.addOnServiceId) || null, price: priceOf(addOn.price), qty: qtyOf(addOn.items) });
    }
  }
  return lines;
}

/**
 * Decision: the discount never exceeds what is still payable after the prepaid amount
 * (no refunds). When it would, the allowance is shared across the applied promotions in
 * proportion to their savings, and within each promotion across its lines.
 */
function capApplied(applied, allowanceMinor) {
  const totalMinor = applied.reduce((s, a) => s + (a.totalSavingMinor || 0), 0);
  if (totalMinor <= allowanceMinor) return { applied, totalMinor, capped: false };
  const shares = allocateMinor(allowanceMinor, applied.map((a) => a.totalSavingMinor || 0));
  const out = applied.map((a, i) => {
    const lineShares = allocateMinor(shares[i], a.adjustments.map((adj) => Math.abs(adj.amountMinor || 0)));
    return {
      ...a,
      totalSavingMinor: shares[i],
      totalSaving: fromMinor(shares[i]),
      adjustments: a.adjustments.map((adj, j) => ({ ...adj, amountMinor: -lineShares[j], amount: -fromMinor(lineShares[j]) })),
    };
  });
  return { applied: out, totalMinor: shares.reduce((s, v) => s + v, 0), capped: true };
}

/**
 * Price the booking's held promotions on the real invoice lines.
 *
 * @param {{ bookingId: number, allowance: number }} params allowance = most the promotions may
 *   take off (payable balance before discount, minus any legacy coupon discount)
 * @returns {{ amount: number, applied: Array, frozen: boolean, capped: boolean }}
 *   frozen — paid already: the stored discount is returned unchanged.
 */
async function priceAtInvoice({ bookingId, allowance }) {
  const none = { amount: 0, applied: [], frozen: false, capped: false };
  const b = await Booking.findByPk(bookingId, {
    attributes: ['id', 'customerId', 'zoneId', 'paymentType', 'createdAt', 'collectionDate', 'deliveryDate'],
  });
  if (!b) return none;

  // Once paid, the discount is locked: later invoice edits never re-price it.
  if (await Redemption.count({ where: { bookingId, status: 'COMMITTED' } })) {
    return { ...none, amount: await storedPromotionDiscount(bookingId), frozen: true };
  }

  const holds = isPromotionsCheckoutEnabled(b.zoneId)
    ? await Redemption.findAll({ where: { bookingId, status: 'RESERVED' } })
    : [];
  if (!holds.length) {
    // Flag off (kill switch) or nothing held: no promotion lines on an unpaid invoice.
    if (await storedPromotionDiscount(bookingId)) await ledger.writeOrderAdjustments(bookingId, []);
    return none;
  }

  const promotions = await loadHeldPromotions([...new Set(holds.map((h) => h.promotionId))], b.zoneId);
  const coupons = new Map(holds.filter((h) => h.couponCodeId).map((h) => [h.promotionId, { id: h.couponCodeId, code: h.couponCode }]));
  const context = await buildPromotionContext({
    zoneId: b.zoneId,
    customerId: b.customerId,
    allowRawBasket: true,
    basket: { lineItems: await invoiceLineItems(bookingId), deliveryFee: 0 },
    paymentMethod: normalizePaymentType(b.paymentType),
    collectionDate: b.collectionDate,
    deliveryDate: b.deliveryDate,
    // Judged as of the booking: its time, its customer history (later orders do not count).
    allowClockOverride: true,
    currentTime: b.createdAt,
    customerAsOf: { excludeBookingId: b.id, before: b.createdAt },
  });
  const result = await evaluatePromotions(context, { promotions, coupons });
  const { applied, totalMinor, capped } = capApplied(result.applied, Math.max(0, toMinor(allowance)));

  await ledger.writeOrderAdjustments(bookingId, applied);
  const byPromotion = new Map(applied.map((a) => [a.promotionId, a.totalSavingMinor]));
  for (const h of holds) {
    const amount = fromMinor(byPromotion.get(h.promotionId) || 0);
    if (Number(h.discountAmount) !== amount) await h.update({ discountAmount: amount });
  }

  return {
    amount: fromMinor(totalMinor),
    capped,
    frozen: false,
    applied: applied.map((a) => ({
      promotionId: a.promotionId,
      name: a.promotionName,
      couponCode: a.couponCode,
      amount: fromMinor(a.totalSavingMinor),
    })),
  };
}

module.exports = {
  isPromotionCode,
  usesPromotionCode,
  validateCodeForCheckout,
  attachAtBooking,
  releaseForBooking,
  priceAtInvoice,
  storedPromotionDiscount,
  invoiceLineItems,
  capApplied,
};

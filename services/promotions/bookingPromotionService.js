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

const { couponCode: CouponCode } = require('../../models');
const { ValidationError } = require('../../middlewares/universalErrorHandler');
const { CUSTOMER_RESERVE_MESSAGE } = require('../../utils/couponDiscount');
const { isPromotionsCheckoutEnabled } = require('./checkoutFlag');
const { buildPromotionContext } = require('./contextBuilder');
const { evaluateBookingEligibility, buildOfferLabel } = require('./promotionEngine');
const { effectiveValues, resolveDiscountMode } = require('./benefitHandlers');
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

module.exports = {
  isPromotionCode,
  usesPromotionCode,
  validateCodeForCheckout,
  attachAtBooking,
  releaseForBooking,
};

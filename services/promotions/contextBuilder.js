'use strict';

/**
 * Server-side PromotionContext builder (master plan §131 steps 1–6).
 *
 * Customers never supply their own order history, segments, prices or clock:
 * those come from the database here. The client only says WHAT it wants to buy
 * (catalog ids + quantities), where (zone), and checkout choices (coupon,
 * payment method, collection/delivery dates).
 */

const { Op } = require('sequelize');
const {
  booking: Booking,
  zone: Zone,
  subCategories: SubCategories,
  categories: Categories,
} = require('../../models');
const { CANCELLED } = require('../../constants/bookingStatusIds');
const { getCountryContextFromZoneId } = require('../../utils/countryTimeZone');
const { resolvePrice } = require('../Admin/zoneCatalogService');
const { ValidationError } = require('../../middlewares/universalErrorHandler');
const { toDecimal, toMinor, fromMinor } = require('./moneyUtils');
const { localDay, resolveTimeZone, toDate } = require('./promotionTime');
const { PAYMENT_METHODS } = require('./conditionEvaluator');

const INACTIVE_AFTER_DAYS = 90;
const MAX_ITEMS = 200;

/** Customer facts used by eligibility rules. */
async function loadCustomerFacts(customerId) {
  if (!customerId) return { id: null, orderCount: 0, isFirstOrder: true, type: 'new', segments: [] };
  const where = { customerId, bookingStatusId: { [Op.ne]: CANCELLED } };
  const [orderCount, last] = await Promise.all([
    Booking.count({ where }),
    Booking.findOne({ where, attributes: ['createdAt'], order: [['createdAt', 'DESC']] }),
  ]);
  let type = 'new';
  if (orderCount > 0) {
    const lastAt = last?.createdAt ? new Date(last.createdAt).getTime() : Date.now();
    type = Date.now() - lastAt > INACTIVE_AFTER_DAYS * 86400000 ? 'inactive' : 'returning';
  }
  // No segment system exists yet; CUSTOMER_SEGMENT rules never match until one does.
  return { id: Number(customerId), orderCount, isFirstOrder: orderCount === 0, type, segments: [] };
}

async function loadZoneFacts(zoneId) {
  const id = Number(zoneId);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('zoneId is required');
  const row = await Zone.findByPk(id, { attributes: ['id'] });
  if (!row) throw new ValidationError('Zone not found');
  const country = await getCountryContextFromZoneId(id).catch(() => null);
  return {
    id,
    timezone: resolveTimeZone(country?.ianaTimeZone),
    // Delivery is free today (home config "Free 24h"), so delivery promotions save £0.
    // zone.serviceCharge is the service fee, not a delivery fee: never waive it here.
    deliveryFee: 0,
  };
}

/**
 * Price catalog items for a zone using the same resolver as the customer catalog
 * (zone overrides + service discounts already applied).
 */
async function priceItems(zoneId, items) {
  if (!Array.isArray(items) || !items.length) return [];
  if (items.length > MAX_ITEMS) throw new ValidationError(`At most ${MAX_ITEMS} items`);

  const subIds = items.map((i) => Number(i.subCategoryId)).filter((n) => n > 0);
  const subs = subIds.length
    ? await SubCategories.findAll({ where: { id: subIds }, attributes: ['id', 'categoryId'] })
    : [];
  const catIds = [...new Set(subs.map((s) => Number(s.categoryId)).filter(Boolean))];
  const cats = catIds.length ? await Categories.findAll({ where: { id: catIds }, attributes: ['id', 'serviceId'] }) : [];
  const subCat = new Map(subs.map((s) => [Number(s.id), Number(s.categoryId)]));
  const catService = new Map(cats.map((c) => [Number(c.id), Number(c.serviceId)]));

  const lines = [];
  for (const item of items) {
    const qty = Math.round(Number(item.qty ?? item.quantity ?? 1));
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new ValidationError('Item quantity must be between 1 and 999');
    if (Number(item.subCategoryId) > 0) {
      const subCategoryId = Number(item.subCategoryId);
      const priced = await resolvePrice(zoneId, { subCategoryId });
      const categoryId = subCat.get(subCategoryId) || null;
      lines.push({
        subCategoryId, addonId: null, categoryId,
        serviceId: categoryId ? catService.get(categoryId) || null : null,
        price: toDecimal(priced.price), qty,
      });
    } else if (Number(item.addOnServiceId ?? item.addonId) > 0) {
      const addonId = Number(item.addOnServiceId ?? item.addonId);
      const priced = await resolvePrice(zoneId, { addOnServiceId: addonId });
      lines.push({ subCategoryId: null, addonId, categoryId: null, serviceId: null, price: toDecimal(priced.price), qty });
    } else {
      throw new ValidationError('Each item needs subCategoryId or addOnServiceId');
    }
  }
  return lines;
}

function normalizeCoupons(couponCodes) {
  const list = Array.isArray(couponCodes) ? couponCodes : couponCodes != null ? [couponCodes] : [];
  return [...new Set(list.map((c) => String(c).trim().toUpperCase()).filter(Boolean))].slice(0, 5);
}

/**
 * @param {object} input
 * @param {number} input.zoneId
 * @param {number} [input.customerId]       always req.user.id for customers
 * @param {Array}  [input.items]            [{ subCategoryId | addOnServiceId, qty }]
 * @param {object} [input.basket]           raw what-if basket — only when allowRawBasket (admin simulate)
 * @param {boolean} [input.allowRawBasket]
 * @param {boolean} [input.allowClockOverride] admin only: honour input.currentTime
 * @param {boolean} [input.strict]          order placement: unknown checkout facts fail
 */
async function buildPromotionContext(input = {}) {
  const zone = await loadZoneFacts(input.zoneId);
  const customer = await loadCustomerFacts(input.customerId);

  let lineItems;
  let deliveryFee = zone.deliveryFee;
  if (Array.isArray(input.items) && input.items.length) {
    lineItems = await priceItems(zone.id, input.items);
  } else if (input.allowRawBasket && input.basket) {
    lineItems = (input.basket.lineItems || []).map((li) => ({
      subCategoryId: li.subCategoryId ?? null,
      addonId: li.addonId ?? null,
      categoryId: li.categoryId ?? null,
      serviceId: li.serviceId ?? null,
      price: toDecimal(li.price),
      qty: Math.max(1, Math.round(Number(li.qty) || 1)),
    }));
    if (input.basket.deliveryFee != null) deliveryFee = toDecimal(input.basket.deliveryFee);
  } else {
    lineItems = [];
  }

  const subtotalMinor = lineItems.reduce((s, li) => s + toMinor(li.price) * li.qty, 0);
  const rawSubtotal = input.allowRawBasket && !lineItems.length ? toDecimal(input.basket?.subtotal) : null;

  const paymentMethod = input.paymentMethod != null ? String(input.paymentMethod).toLowerCase().trim() : null;
  if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) throw new ValidationError('paymentMethod must be card or cash');

  const currentTime = (input.allowClockOverride && toDate(input.currentTime)) || new Date();

  return {
    customer,
    zone: { id: zone.id, timezone: zone.timezone },
    basket: {
      subtotal: rawSubtotal != null ? rawSubtotal : fromMinor(subtotalMinor),
      itemCount: lineItems.reduce((s, li) => s + li.qty, 0),
      deliveryFee,
      lineItems,
    },
    timing: {
      collectionDay: localDay(input.collectionDate, zone.timezone),
      deliveryDay: localDay(input.deliveryDate, zone.timezone),
      bookingTime: null,
      turnaroundType: input.turnaroundType || null,
    },
    couponCodes: normalizeCoupons(input.couponCodes),
    paymentMethod,
    currentTime,
    strict: Boolean(input.strict),
  };
}

module.exports = { buildPromotionContext, loadCustomerFacts, priceItems, normalizeCoupons };

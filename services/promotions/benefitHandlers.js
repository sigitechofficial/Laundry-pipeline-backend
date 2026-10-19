'use strict';

/**
 * Benefit calculation — what a promotion is worth against the current basket.
 *
 * All maths is in integer minor units (pence). Promotions are applied one after
 * another against a shared PricingState, so each one only discounts what is
 * still left on a line. That keeps the invariants from the master plan:
 *   discount >= 0, line balance >= 0, sum(line discounts) == total discount,
 *   total discount <= subtotal (+ delivery fee for delivery promos).
 *
 * discountValue meaning (see resolveDiscountMode):
 *   percent → % of the remaining amount (capped by maxDiscountCap for the whole promotion)
 *   amount  → basket scope: £ off the basket; item scope: £ off each matching unit
 *   fixed_price → discountValue is the price the remaining basket is sold for
 *   bundle (Bulk price) → discountValue is the price of benefitConfig.bundleQuantity pieces
 */

const { toDecimal, toMinor, fromMinor, money, percentOfMinor, allocateMinor } = require('./moneyUtils');

const PERCENT_ONLY = ['percentage_discount', 'first_order_discount', 'first_x_orders_discount'];
const AMOUNT_ONLY = ['fixed_amount_discount', 'delivery_discount', 'fixed_price', 'bundle'];
const DELIVERY_TYPES = ['free_delivery', 'delivery_discount'];
const ITEM_TYPES = ['item_discount', 'category_discount', 'service_discount', 'bundle'];
const BASKET_TYPES = [
  'percentage_discount', 'fixed_amount_discount', 'basket_discount', 'fixed_price',
  'first_order_discount', 'first_x_orders_discount',
];
const SUPPORTED_BENEFIT_TYPES = [...new Set([...DELIVERY_TYPES, ...ITEM_TYPES, ...BASKET_TYPES, 'cashback'])];

const CURRENCY_SYMBOLS = { GBP: '£', USD: '$', EUR: '€' };

function currencySymbol(currency) {
  return CURRENCY_SYMBOLS[String(currency || 'GBP').toUpperCase()] || `${currency} `;
}

/** 'delivery' | 'item' | 'basket' | 'cashback' | null (unsupported). */
function benefitScope(benefitType) {
  if (DELIVERY_TYPES.includes(benefitType)) return 'delivery';
  if (ITEM_TYPES.includes(benefitType)) return 'item';
  if (BASKET_TYPES.includes(benefitType)) return 'basket';
  if (benefitType === 'cashback') return 'cashback';
  return null;
}

function resolveDiscountMode(promotion) {
  if (PERCENT_ONLY.includes(promotion.benefitType)) return 'percent';
  if (AMOUNT_ONLY.includes(promotion.benefitType)) return 'amount';
  return promotion.discountMode === 'amount' ? 'amount' : 'percent';
}

/** Discount value / cap / minimum for this zone, honouring a zone override. */
function effectiveValues(promotion, zoneOverride) {
  const pick = (key) => (zoneOverride && zoneOverride[key] != null ? zoneOverride[key] : promotion[key]);
  const cap = pick('maxDiscountCap');
  const min = pick('minSubtotal');
  return {
    discountValue: toDecimal(pick('discountValue')),
    maxDiscountCap: cap != null && toDecimal(cap) > 0 ? toDecimal(cap) : null,
    minSubtotal: min != null ? toDecimal(min) : null,
    currency: (zoneOverride && zoneOverride.currency) || promotion.currency || 'GBP',
  };
}

// ─── Pricing state ──────────────────────────────────────────────────────────

/**
 * Build the mutable state for one evaluation from context.basket.
 * A basket with only a subtotal (admin what-if) becomes one synthetic basket line.
 */
function createPricingState(context = {}) {
  const basket = context.basket || {};
  const items = Array.isArray(basket.lineItems) ? basket.lineItems : [];
  let lines = items.map((li, index) => {
    const qty = Math.max(1, Math.round(Number(li.qty) || 1));
    const amountMinor = Math.max(0, toMinor(li.price) * qty);
    return {
      index,
      subCategoryId: li.subCategoryId != null ? Number(li.subCategoryId) : null,
      addonId: li.addonId != null ? Number(li.addonId) : null,
      categoryId: li.categoryId != null ? Number(li.categoryId) : null,
      serviceId: li.serviceId != null ? Number(li.serviceId) : null,
      qty,
      originalMinor: amountMinor,
      balanceMinor: amountMinor,
      itemPromotionIds: [],
      exclusive: false,
    };
  });
  if (!lines.length && toMinor(basket.subtotal) > 0) {
    const amountMinor = toMinor(basket.subtotal);
    lines = [{
      index: 0, subCategoryId: null, addonId: null, categoryId: null, serviceId: null, qty: 1,
      originalMinor: amountMinor, balanceMinor: amountMinor, itemPromotionIds: [], exclusive: false,
    }];
  }
  const deliveryMinor = Math.max(0, toMinor(basket.deliveryFee));
  return { lines, deliveryMinor, deliveryBalanceMinor: deliveryMinor };
}

function remainingSubtotalMinor(state) {
  return state.lines.reduce((s, l) => s + l.balanceMinor, 0);
}

/**
 * Add-ons are their own catalog. A category or service discount applies to the
 * garments (and a service priced as one line) in that category or service.
 * An add-on on the same invoice row keeps the parent ids for display, but it is
 * not part of the category or service unless the promotion targets add-ons.
 */
function lineMatchesTarget(promotion, line) {
  const ids = Array.isArray(promotion.targetIds) ? promotion.targetIds.map(Number) : [];
  const isAddon = line.addonId != null;
  if (promotion.benefitType === 'category_discount') {
    return !isAddon && line.categoryId != null && ids.includes(line.categoryId);
  }
  if (promotion.benefitType === 'service_discount') {
    return !isAddon && line.serviceId != null && ids.includes(line.serviceId);
  }
  switch (promotion.targetType) {
    case 'all': return true;
    case 'subCategory': return !isAddon && line.subCategoryId != null && ids.includes(line.subCategoryId);
    case 'addon': return isAddon && ids.includes(line.addonId);
    case 'category': return !isAddon && line.categoryId != null && ids.includes(line.categoryId);
    case 'service': return !isAddon && line.serviceId != null && ids.includes(line.serviceId);
    default: return false;
  }
}

/** Pieces in one Bulk price group ("10 for £25" → 10). 0 when not set. */
function bundleQuantity(promotion) {
  let config = promotion.benefitConfig;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { config = null; }
  }
  const n = Number(config?.bundleQuantity);
  return Number.isInteger(n) && n >= 2 ? n : 0;
}

/** Can this item promotion still touch the line? (stacking on the same line) */
function lineOpenForItemPromotion(promotion, line) {
  if (line.balanceMinor <= 0) return false;
  if (!line.itemPromotionIds.length) return true;
  return Boolean(promotion.stackable) && !line.exclusive;
}

// ─── Compute (pure) ─────────────────────────────────────────────────────────

/**
 * Bulk price: every full group of `size` pieces of the chosen items costs `priceMinor`;
 * pieces left over pay the normal price. Pieces of all chosen items count together and
 * the cheapest are grouped first. A group is never made dearer than its normal price.
 * @returns {number[]} discount per line (minor units)
 */
function bundleLineSavings(promotion, state, size, priceMinor) {
  const out = state.lines.map(() => 0);
  if (!size) return out;
  const pieces = [];
  state.lines.forEach((line, i) => {
    if (!lineMatchesTarget(promotion, line) || !lineOpenForItemPromotion(promotion, line)) return;
    const each = Math.floor(line.balanceMinor / line.qty);
    const spare = line.balanceMinor - each * line.qty;
    for (let k = 0; k < line.qty; k += 1) pieces.push({ i, value: each + (k < spare ? 1 : 0) });
  });
  pieces.sort((a, b) => a.value - b.value || a.i - b.i);
  for (let start = 0; start + size <= pieces.length; start += size) {
    const group = pieces.slice(start, start + size);
    const normal = group.reduce((s, p) => s + p.value, 0);
    const shares = allocateMinor(Math.max(0, normal - priceMinor), group.map((p) => p.value));
    group.forEach((p, k) => { out[p.i] += shares[k]; });
  }
  return out;
}

/**
 * What the promotion would take off right now. Does not mutate state.
 * @returns {{ lineMinor:number[], deliveryMinor:number, cashbackMinor:number, totalSavingMinor:number, label:string, description:string }}
 */
function computeBenefit(promotion, state, options = {}) {
  const scope = benefitScope(promotion.benefitType);
  const empty = { lineMinor: state.lines.map(() => 0), deliveryMinor: 0, cashbackMinor: 0, totalSavingMinor: 0, label: '', description: '' };
  if (!scope) return { ...empty, unsupported: true };

  const { discountValue, maxDiscountCap, currency } = effectiveValues(promotion, options.zoneOverride);
  const mode = resolveDiscountMode(promotion);
  const sym = currencySymbol(currency);
  const capMinor = maxDiscountCap != null ? toMinor(maxDiscountCap) : null;
  const valueLabel = mode === 'percent' ? `${discountValue}%` : `${sym}${money(discountValue)}`;

  if (scope === 'delivery') {
    const available = state.deliveryBalanceMinor;
    const saving = promotion.benefitType === 'free_delivery' ? available : Math.min(toMinor(discountValue), available);
    return {
      ...empty,
      deliveryMinor: Math.max(0, saving),
      totalSavingMinor: Math.max(0, saving),
      label: promotion.benefitType === 'free_delivery' ? 'Free Delivery' : `${sym}${money(fromMinor(saving))} off delivery`,
      description: promotion.benefitType === 'free_delivery' ? 'Delivery fee waived' : 'Delivery discount',
    };
  }

  if (scope === 'item') {
    const isBundle = promotion.benefitType === 'bundle';
    const raw = isBundle
      ? bundleLineSavings(promotion, state, bundleQuantity(promotion), toMinor(discountValue))
      : state.lines.map((line) => {
        if (!lineMatchesTarget(promotion, line) || !lineOpenForItemPromotion(promotion, line)) return 0;
        const want = mode === 'percent'
          ? percentOfMinor(line.balanceMinor, discountValue)
          : toMinor(discountValue) * line.qty;
        return Math.max(0, Math.min(want, line.balanceMinor));
      });
    const total = raw.reduce((s, v) => s + v, 0);
    const lineMinor = capMinor != null && total > capMinor ? allocateMinor(capMinor, raw) : raw;
    const saving = lineMinor.reduce((s, v) => s + v, 0);
    const kind = isBundle ? 'Bulk price'
      : `${promotion.benefitType === 'item_discount' ? 'Item' : promotion.benefitType === 'category_discount' ? 'Category' : 'Service'} discount`;
    return {
      ...empty,
      lineMinor,
      totalSavingMinor: saving,
      label: isBundle ? `${bundleQuantity(promotion)} for ${valueLabel}` : mode === 'percent' ? `${valueLabel} OFF` : `${valueLabel} OFF each`,
      description: `${kind}${capMinor != null ? ` (max ${sym}${money(maxDiscountCap)})` : ''}`,
    };
  }

  const baseMinor = remainingSubtotalMinor(state);

  if (scope === 'cashback') {
    let cashback = mode === 'percent' ? percentOfMinor(baseMinor, discountValue) : toMinor(discountValue);
    if (capMinor != null) cashback = Math.min(cashback, capMinor);
    cashback = Math.max(0, Math.min(cashback, baseMinor));
    return {
      ...empty,
      cashbackMinor: cashback,
      label: `${valueLabel} cashback`,
      description: 'Cashback added to your credit after delivery',
    };
  }

  // Basket scope
  let saving;
  let label;
  let description;
  if (promotion.benefitType === 'fixed_price') {
    saving = Math.max(0, baseMinor - toMinor(discountValue));
    label = `Special price ${sym}${money(discountValue)}`;
    description = 'Fixed price offer';
  } else if (mode === 'percent') {
    saving = percentOfMinor(baseMinor, discountValue);
    if (capMinor != null) saving = Math.min(saving, capMinor);
    label = `${valueLabel} OFF`;
    description = `${valueLabel} discount${capMinor != null ? ` (max ${sym}${money(maxDiscountCap)})` : ''}`;
  } else {
    saving = toMinor(discountValue);
    label = `${valueLabel} OFF`;
    description = `${valueLabel} off your order`;
  }
  saving = Math.max(0, Math.min(saving, baseMinor));
  const lineMinor = allocateMinor(saving, state.lines.map((l) => l.balanceMinor));
  return { ...empty, lineMinor, totalSavingMinor: saving, label, description };
}

// ─── Apply (mutates state) ──────────────────────────────────────────────────

function applyBenefit(promotion, state, benefit) {
  const scope = benefitScope(promotion.benefitType);
  benefit.lineMinor.forEach((amount, i) => {
    if (amount <= 0) return;
    const line = state.lines[i];
    line.balanceMinor -= amount;
    if (scope === 'item') {
      line.itemPromotionIds.push(promotion.id);
      if (!promotion.stackable) line.exclusive = true;
    }
  });
  state.deliveryBalanceMinor -= benefit.deliveryMinor;
}

/** Turn a computed benefit into adjustment rows (negative amounts reduce the order). */
function toAdjustments(state, benefit) {
  const rows = [];
  benefit.lineMinor.forEach((amount, i) => {
    if (amount <= 0) return;
    const line = state.lines[i];
    const placed = line.addonId != null
      ? { lineType: 'addon', lineItemId: line.addonId }
      : line.subCategoryId != null
        ? { lineType: 'subCategory', lineItemId: line.subCategoryId }
        : line.serviceId != null
          ? { lineType: 'service', lineItemId: line.serviceId }
          : { lineType: 'basket', lineItemId: null };
    rows.push({
      lineType: placed.lineType,
      lineItemId: placed.lineItemId,
      amountMinor: -amount,
      amount: -fromMinor(amount),
      label: benefit.label,
      description: benefit.description,
    });
  });
  if (benefit.deliveryMinor > 0) {
    rows.push({
      lineType: 'delivery', lineItemId: null,
      amountMinor: -benefit.deliveryMinor, amount: -fromMinor(benefit.deliveryMinor),
      label: benefit.label, description: benefit.description,
    });
  }
  if (benefit.cashbackMinor > 0) {
    rows.push({
      lineType: 'basket', lineItemId: null, amountMinor: 0, amount: 0,
      label: benefit.label, description: benefit.description,
      meta: { cashbackAmount: fromMinor(benefit.cashbackMinor), cashbackMinor: benefit.cashbackMinor },
    });
  }
  return rows;
}

/**
 * Stand-alone calculation of a single promotion against a fresh basket.
 * Kept for simulations/tests; the engine uses compute/apply on a shared state.
 */
function calculateBenefit(promotion, context, options = {}) {
  const state = createPricingState(context);
  const benefit = computeBenefit(promotion, state, options);
  if (benefit.unsupported) {
    console.warn(`[BenefitHandler] No handler for benefitType="${promotion.benefitType}"`);
  }
  return {
    adjustments: toAdjustments(state, benefit),
    totalSaving: fromMinor(benefit.totalSavingMinor),
    totalSavingMinor: benefit.totalSavingMinor,
    cashbackAmount: fromMinor(benefit.cashbackMinor),
    cashbackMinor: benefit.cashbackMinor,
  };
}

/**
 * What the spend / quantity limits are measured on. Item, category and service
 * discounts count only the items they target (a £100 maximum on Wash & Iron is not
 * broken by adding other services); every other type counts the whole basket.
 */
function limitBasket(promo, context) {
  const basket = context.basket || {};
  if (benefitScope(promo.benefitType) !== 'item') {
    return { subtotal: toDecimal(basket.subtotal), itemCount: basket.itemCount || 0, offerItemsOnly: false };
  }
  const lines = (basket.lineItems || []).filter((li) => lineMatchesTarget(promo, li));
  return {
    subtotal: fromMinor(lines.reduce((s, li) => s + toMinor(li.price) * (li.qty || 0), 0)),
    itemCount: lines.reduce((s, li) => s + (li.qty || 0), 0),
    offerItemsOnly: true,
  };
}

module.exports = {
  SUPPORTED_BENEFIT_TYPES,
  calculateBenefit,
  computeBenefit,
  applyBenefit,
  toAdjustments,
  createPricingState,
  remainingSubtotalMinor,
  benefitScope,
  resolveDiscountMode,
  effectiveValues,
  currencySymbol,
  lineMatchesTarget,
  limitBasket,
  bundleQuantity,
};

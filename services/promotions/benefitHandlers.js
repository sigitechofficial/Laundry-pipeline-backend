'use strict';

/**
 * Benefit handlers — calculate the actual discount/benefit for each promotion type.
 *
 * Each handler receives:
 *   promotion   — the promotion row (with zone overrides resolved)
 *   context     — the PromotionContext
 *   options     — { zoneOverride? } resolved values for this zone
 *
 * Returns:
 *   { adjustments: [{ lineType, lineItemId, amount, label, description }], totalSaving }
 */

const { toDecimal, money, percentOf, minMoney, subtractMoney, allocateProportionally } = require('./moneyUtils');

// ─── Handler registry ────────────────────────────────────────────────────────

const benefitHandlers = {};

/**
 * Get effective discount value / cap considering zone overrides.
 */
function effectiveValues(promotion, zoneOverride) {
  return {
    discountValue: toDecimal(zoneOverride?.discountValue ?? promotion.discountValue),
    maxDiscountCap: zoneOverride?.maxDiscountCap != null ? toDecimal(zoneOverride.maxDiscountCap) : (promotion.maxDiscountCap != null ? toDecimal(promotion.maxDiscountCap) : null),
    minSubtotal: toDecimal(zoneOverride?.minSubtotal ?? promotion.minSubtotal),
    currency: zoneOverride?.currency || promotion.currency || 'GBP',
  };
}

// ─── Percentage discount (basket-level or item-level) ────────────────────────

benefitHandlers.percentage_discount = function (promotion, context, options = {}) {
  const { discountValue, maxDiscountCap } = effectiveValues(promotion, options.zoneOverride);
  const subtotal = toDecimal(context.basket?.subtotal);

  let saving = percentOf(subtotal, discountValue);
  if (maxDiscountCap != null && maxDiscountCap > 0) {
    saving = minMoney(saving, maxDiscountCap);
  }
  saving = minMoney(saving, subtotal);

  if (saving <= 0) return { adjustments: [], totalSaving: 0 };

  const lineItems = context.basket?.lineItems || [];
  const lineAmounts = lineItems.map((li) => toDecimal(li.price) * (li.qty || 1));
  const allocations = allocateProportionally(saving, lineAmounts);

  const adjustments = lineItems.map((li, i) => ({
    lineType: li.addonId ? 'addon' : 'subCategory',
    lineItemId: li.addonId || li.subCategoryId,
    amount: -allocations[i],
    label: `${discountValue}% OFF`,
    description: `${discountValue}% discount${maxDiscountCap ? ` (max £${money(maxDiscountCap)})` : ''}`,
  })).filter((a) => a.amount < 0);

  return { adjustments, totalSaving: saving };
};

// ─── Fixed amount discount (basket-level) ────────────────────────────────────

benefitHandlers.fixed_amount_discount = function (promotion, context, options = {}) {
  const { discountValue } = effectiveValues(promotion, options.zoneOverride);
  const subtotal = toDecimal(context.basket?.subtotal);

  const saving = minMoney(discountValue, subtotal);
  if (saving <= 0) return { adjustments: [], totalSaving: 0 };

  const lineItems = context.basket?.lineItems || [];
  const lineAmounts = lineItems.map((li) => toDecimal(li.price) * (li.qty || 1));
  const allocations = allocateProportionally(saving, lineAmounts);

  const adjustments = lineItems.map((li, i) => ({
    lineType: li.addonId ? 'addon' : 'subCategory',
    lineItemId: li.addonId || li.subCategoryId,
    amount: -allocations[i],
    label: `£${money(discountValue)} OFF`,
    description: `Fixed £${money(discountValue)} discount`,
  })).filter((a) => a.amount < 0);

  return { adjustments, totalSaving: saving };
};

// ─── Basket discount (same as fixed/percentage but explicitly basket-scoped) ─

benefitHandlers.basket_discount = function (promotion, context, options = {}) {
  const { discountValue, maxDiscountCap } = effectiveValues(promotion, options.zoneOverride);
  const subtotal = toDecimal(context.basket?.subtotal);
  const isPercent = promotion.benefitType === 'basket_discount' && String(promotion.discountValue).includes('%');

  // Basket discount supports both percentage and fixed — determine from discountType if available
  if (toDecimal(discountValue) > 100) {
    // Likely fixed amount
    return benefitHandlers.fixed_amount_discount(promotion, context, options);
  }

  // Default: treat as percentage
  let saving = percentOf(subtotal, discountValue);
  if (maxDiscountCap != null && maxDiscountCap > 0) {
    saving = minMoney(saving, maxDiscountCap);
  }
  saving = minMoney(saving, subtotal);

  if (saving <= 0) return { adjustments: [], totalSaving: 0 };

  return {
    adjustments: [{
      lineType: 'basket',
      lineItemId: null,
      amount: -saving,
      label: `${discountValue}% OFF basket`,
      description: `Basket ${discountValue}% discount`,
    }],
    totalSaving: saving,
  };
};

// ─── Free delivery ──────────────────────────────────────────────────────────

benefitHandlers.free_delivery = function (promotion, context) {
  const deliveryFee = toDecimal(context.basket?.deliveryFee);
  if (deliveryFee <= 0) return { adjustments: [], totalSaving: 0 };

  return {
    adjustments: [{
      lineType: 'delivery',
      lineItemId: null,
      amount: -deliveryFee,
      label: 'Free Delivery',
      description: 'Delivery fee waived',
    }],
    totalSaving: deliveryFee,
  };
};

// ─── Delivery discount ─────────────────────────────────────────────────────

benefitHandlers.delivery_discount = function (promotion, context, options = {}) {
  const { discountValue } = effectiveValues(promotion, options.zoneOverride);
  const deliveryFee = toDecimal(context.basket?.deliveryFee);
  if (deliveryFee <= 0) return { adjustments: [], totalSaving: 0 };

  const saving = minMoney(discountValue, deliveryFee);
  return {
    adjustments: [{
      lineType: 'delivery',
      lineItemId: null,
      amount: -saving,
      label: `£${money(saving)} off delivery`,
      description: `Delivery discount`,
    }],
    totalSaving: saving,
  };
};

// ─── Item discount (specific subCategory/addon targets) ─────────────────────

benefitHandlers.item_discount = function (promotion, context, options = {}) {
  const { discountValue, maxDiscountCap } = effectiveValues(promotion, options.zoneOverride);
  const targetIds = Array.isArray(promotion.targetIds) ? promotion.targetIds.map(Number) : [];
  const targetType = promotion.targetType;

  const lineItems = context.basket?.lineItems || [];
  const adjustments = [];
  let totalSaving = 0;

  for (const li of lineItems) {
    let matches = false;
    if (targetType === 'subCategory' && targetIds.includes(Number(li.subCategoryId))) matches = true;
    if (targetType === 'addon' && targetIds.includes(Number(li.addonId))) matches = true;
    if (targetType === 'all') matches = true;

    if (!matches) continue;

    const itemTotal = toDecimal(li.price) * (li.qty || 1);
    let saving = percentOf(itemTotal, discountValue);
    if (maxDiscountCap != null && maxDiscountCap > 0) {
      saving = minMoney(saving, maxDiscountCap);
    }
    saving = minMoney(saving, itemTotal);

    if (saving > 0) {
      adjustments.push({
        lineType: li.addonId ? 'addon' : 'subCategory',
        lineItemId: li.addonId || li.subCategoryId,
        amount: -saving,
        label: `${discountValue}% OFF`,
        description: `Item discount`,
      });
      totalSaving += saving;
    }
  }

  return { adjustments, totalSaving };
};

// ─── Category discount ──────────────────────────────────────────────────────

benefitHandlers.category_discount = function (promotion, context, options = {}) {
  const { discountValue, maxDiscountCap } = effectiveValues(promotion, options.zoneOverride);
  const targetIds = Array.isArray(promotion.targetIds) ? promotion.targetIds.map(Number) : [];

  const lineItems = context.basket?.lineItems || [];
  const adjustments = [];
  let totalSaving = 0;

  for (const li of lineItems) {
    if (!targetIds.includes(Number(li.categoryId))) continue;

    const itemTotal = toDecimal(li.price) * (li.qty || 1);
    let saving = percentOf(itemTotal, discountValue);
    if (maxDiscountCap != null && maxDiscountCap > 0) {
      saving = minMoney(saving, maxDiscountCap);
    }
    saving = minMoney(saving, itemTotal);

    if (saving > 0) {
      adjustments.push({
        lineType: 'subCategory',
        lineItemId: li.subCategoryId,
        amount: -saving,
        label: `${discountValue}% OFF`,
        description: `Category discount`,
      });
      totalSaving += saving;
    }
  }

  return { adjustments, totalSaving };
};

// ─── Service discount ───────────────────────────────────────────────────────

benefitHandlers.service_discount = function (promotion, context, options = {}) {
  const { discountValue, maxDiscountCap } = effectiveValues(promotion, options.zoneOverride);
  const targetIds = Array.isArray(promotion.targetIds) ? promotion.targetIds.map(Number) : [];

  const lineItems = context.basket?.lineItems || [];
  const adjustments = [];
  let totalSaving = 0;

  for (const li of lineItems) {
    if (!targetIds.includes(Number(li.serviceId))) continue;

    const itemTotal = toDecimal(li.price) * (li.qty || 1);
    let saving = percentOf(itemTotal, discountValue);
    if (maxDiscountCap != null && maxDiscountCap > 0) {
      saving = minMoney(saving, maxDiscountCap);
    }
    saving = minMoney(saving, itemTotal);

    if (saving > 0) {
      adjustments.push({
        lineType: 'subCategory',
        lineItemId: li.subCategoryId,
        amount: -saving,
        label: `${discountValue}% OFF`,
        description: `Service discount`,
      });
      totalSaving += saving;
    }
  }

  return { adjustments, totalSaving };
};

// ─── Fixed price offer ──────────────────────────────────────────────────────

benefitHandlers.fixed_price = function (promotion, context, options = {}) {
  const { discountValue } = effectiveValues(promotion, options.zoneOverride);
  const subtotal = toDecimal(context.basket?.subtotal);
  const fixedPrice = toDecimal(discountValue);
  const saving = subtractMoney(subtotal, fixedPrice);

  if (saving <= 0) return { adjustments: [], totalSaving: 0 };

  return {
    adjustments: [{
      lineType: 'basket',
      lineItemId: null,
      amount: -saving,
      label: `Special price £${money(fixedPrice)}`,
      description: `Fixed price offer`,
    }],
    totalSaving: saving,
  };
};

// ─── First order discount ───────────────────────────────────────────────────

benefitHandlers.first_order_discount = function (promotion, context, options) {
  return benefitHandlers.percentage_discount(promotion, context, options);
};

// ─── First X orders discount ────────────────────────────────────────────────

benefitHandlers.first_x_orders_discount = function (promotion, context, options) {
  return benefitHandlers.percentage_discount(promotion, context, options);
};

// ─── Cashback ───────────────────────────────────────────────────────────────

benefitHandlers.cashback = function (promotion, context, options = {}) {
  const { discountValue, maxDiscountCap } = effectiveValues(promotion, options.zoneOverride);
  const subtotal = toDecimal(context.basket?.subtotal);

  let cashback = percentOf(subtotal, discountValue);
  if (maxDiscountCap != null && maxDiscountCap > 0) {
    cashback = minMoney(cashback, maxDiscountCap);
  }

  return {
    adjustments: [{
      lineType: 'basket',
      lineItemId: null,
      amount: 0, // cashback doesn't reduce order total immediately
      label: `${discountValue}% cashback`,
      description: `Cashback credit issued after order completion`,
      meta: { cashbackAmount: cashback },
    }],
    totalSaving: 0,
    cashbackAmount: cashback,
  };
};

// ─── Buy X Get Y (placeholder for Phase 3) ─────────────────────────────────

benefitHandlers.buy_x_get_y = function () {
  return { adjustments: [], totalSaving: 0 };
};

// ─── Bundle (placeholder for Phase 3) ───────────────────────────────────────

benefitHandlers.bundle = function () {
  return { adjustments: [], totalSaving: 0 };
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Calculate benefit for a promotion against a context.
 *
 * @param {object} promotion - The promotion row
 * @param {object} context - PromotionContext
 * @param {object} options - { zoneOverride? }
 * @returns {{ adjustments, totalSaving, cashbackAmount? }}
 */
function calculateBenefit(promotion, context, options = {}) {
  const handler = benefitHandlers[promotion.benefitType];
  if (!handler) {
    console.warn(`[BenefitHandler] No handler for benefitType="${promotion.benefitType}"`);
    return { adjustments: [], totalSaving: 0 };
  }
  return handler(promotion, context, options);
}

module.exports = { calculateBenefit, benefitHandlers, effectiveValues };

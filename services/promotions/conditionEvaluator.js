'use strict';

/**
 * Typed condition evaluator for the promotion engine.
 *
 * Each condition is { conditionType, operator, value, logicGroup }.
 * The evaluator receives a PromotionContext and returns { pass, reason? } per condition.
 *
 * PromotionContext shape:
 * {
 *   customer: { id, orderCount, isFirstOrder, type, segments, loyaltyTier },
 *   zone: { id, countryCode, regionCode, currency, timezone },
 *   basket: { subtotal, itemCount, lineItems: [{ serviceId, categoryId, subCategoryId, addonId, qty, price }] },
 *   timing: { collectionDay, deliveryDay, bookingTime, turnaroundType },
 *   couponCodes: ['CODE1'],
 *   paymentMethod: 'card' | 'cash',
 *   currentTime: Date,
 * }
 */

const { toDecimal } = require('./moneyUtils');

// ─── Individual condition handlers ─────────────────────────────────────────

const handlers = {
  ZONE(condition, ctx) {
    const zoneId = ctx.zone?.id;
    if (zoneId == null) return { pass: false, reason: 'No zone in context' };
    return matchValue(condition.operator, zoneId, condition.value, 'Zone');
  },

  CUSTOMER_TYPE(condition, ctx) {
    const type = ctx.customer?.type;
    if (!type) return { pass: false, reason: 'No customer type' };
    return matchValue(condition.operator, type, condition.value, 'Customer type');
  },

  CUSTOMER_SEGMENT(condition, ctx) {
    const segments = ctx.customer?.segments || [];
    const required = Array.isArray(condition.value) ? condition.value : [condition.value];
    const hasAny = required.some((s) => segments.includes(s));
    return hasAny
      ? { pass: true }
      : { pass: false, reason: `Customer not in segment(s): ${required.join(', ')}` };
  },

  FIRST_ORDER(condition, ctx) {
    const isFirst = ctx.customer?.isFirstOrder === true || ctx.customer?.orderCount === 0;
    const required = condition.value === true || condition.value === 'true';
    const pass = required ? isFirst : !isFirst;
    return pass ? { pass: true } : { pass: false, reason: required ? 'Not first order' : 'Is first order' };
  },

  ORDER_COUNT(condition, ctx) {
    const count = ctx.customer?.orderCount ?? 0;
    return matchNumeric(condition.operator, count, condition.value, 'Order count');
  },

  MINIMUM_SUBTOTAL(condition, ctx) {
    const subtotal = toDecimal(ctx.basket?.subtotal);
    const required = toDecimal(condition.value);
    const pass = subtotal >= required;
    return pass
      ? { pass: true }
      : {
          pass: false,
          reason: `Subtotal £${subtotal.toFixed(2)} below minimum £${required.toFixed(2)}`,
          code: 'PROMOTION_MIN_SPEND_NOT_MET',
          meta: { requiredMinor: Math.round(required * 100), currentMinor: Math.round(subtotal * 100) },
        };
  },

  MAXIMUM_SUBTOTAL(condition, ctx) {
    const subtotal = toDecimal(ctx.basket?.subtotal);
    const max = toDecimal(condition.value);
    const pass = subtotal <= max;
    return pass ? { pass: true } : { pass: false, reason: `Subtotal exceeds maximum £${max.toFixed(2)}` };
  },

  MINIMUM_QUANTITY(condition, ctx) {
    const qty = ctx.basket?.itemCount || 0;
    const required = Number(condition.value) || 0;
    return qty >= required
      ? { pass: true }
      : { pass: false, reason: `Need ${required} items, have ${qty}` };
  },

  MAXIMUM_QUANTITY(condition, ctx) {
    const qty = ctx.basket?.itemCount || 0;
    const max = Number(condition.value) || 0;
    return qty <= max ? { pass: true } : { pass: false, reason: `Exceeds max quantity ${max}` };
  },

  SERVICE(condition, ctx) {
    const serviceIds = (ctx.basket?.lineItems || []).map((li) => li.serviceId).filter(Boolean);
    const required = toArray(condition.value).map(Number);
    const hasAny = required.some((id) => serviceIds.includes(id));
    return hasAny
      ? { pass: true }
      : { pass: false, reason: 'Required service not in basket' };
  },

  CATEGORY(condition, ctx) {
    const catIds = (ctx.basket?.lineItems || []).map((li) => li.categoryId).filter(Boolean);
    const required = toArray(condition.value).map(Number);
    const hasAny = required.some((id) => catIds.includes(id));
    return hasAny ? { pass: true } : { pass: false, reason: 'Required category not in basket' };
  },

  PRODUCT(condition, ctx) {
    const subCatIds = (ctx.basket?.lineItems || []).map((li) => li.subCategoryId).filter(Boolean);
    const required = toArray(condition.value).map(Number);
    const hasAny = required.some((id) => subCatIds.includes(id));
    return hasAny ? { pass: true } : { pass: false, reason: 'Required product not in basket' };
  },

  ADDON(condition, ctx) {
    const addonIds = (ctx.basket?.lineItems || []).map((li) => li.addonId).filter(Boolean);
    const required = toArray(condition.value).map(Number);
    const hasAny = required.some((id) => addonIds.includes(id));
    return hasAny ? { pass: true } : { pass: false, reason: 'Required add-on not in basket' };
  },

  COLLECTION_DAY(condition, ctx) {
    const day = ctx.timing?.collectionDay;
    if (day == null) return { pass: true }; // no collection info yet
    return matchValue(condition.operator, day, condition.value, 'Collection day');
  },

  DELIVERY_DAY(condition, ctx) {
    const day = ctx.timing?.deliveryDay;
    if (day == null) return { pass: true };
    return matchValue(condition.operator, day, condition.value, 'Delivery day');
  },

  BOOKING_TIME(condition, ctx) {
    const time = ctx.timing?.bookingTime;
    if (!time) return { pass: true };
    const val = condition.value;
    if (val && val.start && val.end) {
      const pass = time >= val.start && time <= val.end;
      return pass ? { pass: true } : { pass: false, reason: `Booking time ${time} outside ${val.start}-${val.end}` };
    }
    return { pass: true };
  },

  TURNAROUND_TYPE(condition, ctx) {
    const type = ctx.timing?.turnaroundType;
    if (!type) return { pass: true };
    return matchValue(condition.operator, type, condition.value, 'Turnaround type');
  },

  PAYMENT_METHOD(condition, ctx) {
    const pm = ctx.paymentMethod;
    if (!pm) return { pass: true };
    return matchValue(condition.operator, pm, condition.value, 'Payment method');
  },

  SCHEDULE(condition, ctx) {
    const now = ctx.currentTime || new Date();
    const val = condition.value || {};
    if (val.days && Array.isArray(val.days)) {
      const dayOfWeek = now.getDay();
      if (!val.days.includes(dayOfWeek)) {
        return { pass: false, reason: `Not a valid day (${dayOfWeek})` };
      }
    }
    if (val.startTime && val.endTime) {
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (hhmm < val.startTime || hhmm > val.endTime) {
        return { pass: false, reason: `Current time ${hhmm} outside ${val.startTime}-${val.endTime}` };
      }
    }
    return { pass: true };
  },

  COUPON(condition, ctx) {
    const codes = ctx.couponCodes || [];
    const required = toArray(condition.value);
    const hasAny = required.some((c) => codes.map((x) => x.toUpperCase()).includes(c.toUpperCase()));
    return hasAny ? { pass: true } : { pass: false, reason: 'Required coupon code not provided' };
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function toArray(v) {
  return Array.isArray(v) ? v : [v];
}

function matchValue(operator, actual, expected, label) {
  const arr = toArray(expected);
  let pass = false;

  switch (operator) {
    case 'equals':
      pass = String(actual) === String(arr[0]);
      break;
    case 'not_equals':
      pass = String(actual) !== String(arr[0]);
      break;
    case 'in':
      pass = arr.map(String).includes(String(actual));
      break;
    case 'not_in':
      pass = !arr.map(String).includes(String(actual));
      break;
    case 'any':
      pass = true;
      break;
    default:
      pass = arr.map(String).includes(String(actual));
  }

  return pass ? { pass: true } : { pass: false, reason: `${label}: ${actual} did not match ${operator} ${JSON.stringify(expected)}` };
}

function matchNumeric(operator, actual, expected, label) {
  const a = Number(actual) || 0;
  const vals = toArray(expected).map(Number);
  let pass = false;

  switch (operator) {
    case 'gte':
      pass = a >= vals[0];
      break;
    case 'lte':
      pass = a <= vals[0];
      break;
    case 'equals':
      pass = a === vals[0];
      break;
    case 'between':
      pass = vals.length >= 2 && a >= vals[0] && a <= vals[1];
      break;
    default:
      pass = a >= vals[0];
  }

  return pass ? { pass: true } : { pass: false, reason: `${label}: ${a} did not match ${operator} ${JSON.stringify(expected)}` };
}

// ─── Main evaluator ─────────────────────────────────────────────────────────

/**
 * Evaluate an array of conditions against a PromotionContext.
 *
 * Conditions with logicGroup='ALL' must ALL pass.
 * Conditions with logicGroup='ANY' — at least one must pass.
 *
 * @returns {{ eligible: boolean, results: Array<{ type, pass, reason? }> }}
 */
function evaluateConditions(conditions, context) {
  if (!conditions || !conditions.length) {
    return { eligible: true, results: [] };
  }

  const sorted = [...conditions].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  const allGroup = sorted.filter((c) => c.logicGroup === 'ALL' || !c.logicGroup);
  const anyGroup = sorted.filter((c) => c.logicGroup === 'ANY');

  const results = [];

  // ALL conditions must pass
  for (const cond of allGroup) {
    const handler = handlers[cond.conditionType];
    if (!handler) {
      results.push({ type: cond.conditionType, pass: false, reason: `Unknown condition type: ${cond.conditionType}` });
      return { eligible: false, results };
    }
    const result = handler(cond, context);
    results.push({ type: cond.conditionType, ...result });
    if (!result.pass) {
      return { eligible: false, results };
    }
  }

  // ANY group: at least one must pass (if any exist)
  if (anyGroup.length > 0) {
    let anyPassed = false;
    for (const cond of anyGroup) {
      const handler = handlers[cond.conditionType];
      if (!handler) {
        results.push({ type: cond.conditionType, pass: false, reason: `Unknown condition type` });
        continue;
      }
      const result = handler(cond, context);
      results.push({ type: cond.conditionType, ...result });
      if (result.pass) anyPassed = true;
    }
    if (!anyPassed) {
      return { eligible: false, results };
    }
  }

  return { eligible: true, results };
}

module.exports = { evaluateConditions, handlers };

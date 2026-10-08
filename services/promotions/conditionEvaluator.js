'use strict';

/**
 * Typed condition evaluator for the promotion engine.
 *
 * Each condition is { conditionType, operator, value, logicGroup }.
 * The evaluator receives a PromotionContext and returns { pass, reason? } per condition.
 *
 * PromotionContext shape (built server-side by contextBuilder):
 * {
 *   customer: { id, orderCount, isFirstOrder, type: 'new'|'returning'|'inactive', segments },
 *   zone: { id, currency, timezone },
 *   basket: { subtotal, itemCount, deliveryFee, lineItems: [{ serviceId, categoryId, subCategoryId, addonId, qty, price }] },
 *   timing: { collectionDay, deliveryDay, bookingTime, turnaroundType },
 *   couponCodes: ['CODE1'],
 *   paymentMethod: 'card' | 'cash',
 *   currentTime: Date,
 *   strict: boolean   // true at order placement: unknown checkout facts fail instead of pass
 * }
 */

const { toDecimal } = require('./moneyUtils');
const { localClock, isWithinWindow, normalizeHHMM } = require('./promotionTime');

const CUSTOMER_TYPES = ['new', 'returning', 'inactive'];
const PAYMENT_METHODS = ['card', 'cash'];

/**
 * Checkout-time facts (collection day, payment method…) may be unknown while a
 * customer is still browsing. Non-strict evaluation lets them pass as "pending";
 * strict evaluation (order placement) fails them.
 */
function unknownFact(ctx, label) {
  return ctx.strict
    ? { pass: false, reason: `${label} not provided` }
    : { pass: true, pending: true, reason: `${label} not known yet` };
}

// ─── Individual condition handlers ─────────────────────────────────────────

const handlers = {
  ZONE(condition, ctx) {
    const zoneId = ctx.zone?.id;
    if (zoneId == null) return { pass: false, reason: 'No zone in context' };
    return matchValue(condition.operator, zoneId, condition.value, 'Zone');
  },

  CUSTOMER_TYPE(condition, ctx) {
    // Server-derived: new (no previous orders) | returning | inactive (last order > 90 days)
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
    const isFirst = ctx.customer?.orderCount != null
      ? Number(ctx.customer.orderCount) === 0
      : ctx.customer?.isFirstOrder === true;
    const required = condition.value === true || condition.value === 'true';
    const pass = required ? isFirst : !isFirst;
    return pass
      ? { pass: true }
      : { pass: false, reason: required ? 'Not first order' : 'Is first order', code: required ? 'PROMOTION_FIRST_ORDER_ONLY' : undefined };
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
    const serviceIds = (ctx.basket?.lineItems || []).map((li) => Number(li.serviceId)).filter(Boolean);
    const required = toArray(condition.value).map(Number);
    const hasAny = required.some((id) => serviceIds.includes(id));
    return hasAny
      ? { pass: true }
      : { pass: false, reason: 'Required service not in basket' };
  },

  CATEGORY(condition, ctx) {
    const catIds = (ctx.basket?.lineItems || []).map((li) => Number(li.categoryId)).filter(Boolean);
    const required = toArray(condition.value).map(Number);
    const hasAny = required.some((id) => catIds.includes(id));
    return hasAny ? { pass: true } : { pass: false, reason: 'Required category not in basket' };
  },

  PRODUCT(condition, ctx) {
    const subCatIds = (ctx.basket?.lineItems || []).map((li) => Number(li.subCategoryId)).filter(Boolean);
    const required = toArray(condition.value).map(Number);
    const hasAny = required.some((id) => subCatIds.includes(id));
    return hasAny ? { pass: true } : { pass: false, reason: 'Required product not in basket' };
  },

  ADDON(condition, ctx) {
    const addonIds = (ctx.basket?.lineItems || []).map((li) => Number(li.addonId)).filter(Boolean);
    const required = toArray(condition.value).map(Number);
    const hasAny = required.some((id) => addonIds.includes(id));
    return hasAny ? { pass: true } : { pass: false, reason: 'Required add-on not in basket' };
  },

  COLLECTION_DAY(condition, ctx) {
    const day = ctx.timing?.collectionDay;
    if (day == null) return unknownFact(ctx, 'Collection day');
    return matchValue(condition.operator, day, condition.value, 'Collection day');
  },

  DELIVERY_DAY(condition, ctx) {
    const day = ctx.timing?.deliveryDay;
    if (day == null) return unknownFact(ctx, 'Delivery day');
    return matchValue(condition.operator, day, condition.value, 'Delivery day');
  },

  BOOKING_TIME(condition, ctx) {
    // Time the booking is made, in the zone's timezone (defaults to now)
    const time = normalizeHHMM(ctx.timing?.bookingTime) || localClock(ctx.currentTime, ctx.zone?.timezone).hhmm;
    const val = condition.value || {};
    if (!isWithinWindow(time, val.start, val.end)) {
      return { pass: false, reason: `Booking time ${time} outside ${val.start}-${val.end}` };
    }
    return { pass: true };
  },

  TURNAROUND_TYPE(condition, ctx) {
    const type = ctx.timing?.turnaroundType;
    if (!type) return unknownFact(ctx, 'Turnaround type');
    return matchValue(condition.operator, type, condition.value, 'Turnaround type');
  },

  PAYMENT_METHOD(condition, ctx) {
    const pm = ctx.paymentMethod;
    if (!pm) return unknownFact(ctx, 'Payment method');
    return matchValue(condition.operator, pm, condition.value, 'Payment method');
  },

  SCHEDULE(condition, ctx) {
    const { day, hhmm } = localClock(ctx.currentTime, ctx.zone?.timezone);
    const val = condition.value || {};
    if (Array.isArray(val.days) && val.days.length && !val.days.map(Number).includes(day)) {
      return { pass: false, reason: `Not a valid day (${day})` };
    }
    if (!isWithinWindow(hhmm, val.startTime, val.endTime)) {
      return { pass: false, reason: `Current time ${hhmm} outside ${val.startTime}-${val.endTime}` };
    }
    return { pass: true };
  },

  COUPON(condition, ctx) {
    const codes = (ctx.couponCodes || []).map((x) => String(x).trim().toUpperCase());
    const required = toArray(condition.value).map((c) => String(c).trim().toUpperCase());
    const hasAny = required.some((c) => codes.includes(c));
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

// ─── Admin-side validation ──────────────────────────────────────────────────

const isNum = (v) => v !== '' && v != null && typeof v !== 'boolean' && Number.isFinite(Number(v));
const isIdList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => Number.isInteger(Number(x)) && Number(x) > 0);
const isDayList = (v) => Array.isArray(v) && v.length > 0 && v.every((d) => Number.isInteger(Number(d)) && Number(d) >= 0 && Number(d) <= 6);

/**
 * Validate one condition's shape for its type. Returns an error message, or null when valid.
 * Prevents conditions that can never pass (e.g. PAYMENT_METHOD = true).
 */
function validateCondition(c) {
  if (!c || !handlers[c.conditionType]) return `Unknown condition type: ${c && c.conditionType}`;
  if (c.logicGroup && !['ALL', 'ANY'].includes(c.logicGroup)) return `${c.conditionType}: logicGroup must be ALL or ANY`;
  const v = c.value;
  const op = c.operator;
  switch (c.conditionType) {
    case 'ZONE':
    case 'SERVICE':
    case 'CATEGORY':
    case 'PRODUCT':
    case 'ADDON':
      if (!isIdList(v)) return `${c.conditionType}: choose at least one item`;
      if (op && !['in', 'not_in', 'equals'].includes(op)) return `${c.conditionType}: operator must be in or not_in`;
      return null;
    case 'CUSTOMER_TYPE':
      if (!Array.isArray(v) || !v.length || !v.every((t) => CUSTOMER_TYPES.includes(t))) return `CUSTOMER_TYPE: value must be a list of ${CUSTOMER_TYPES.join('/')}`;
      return null;
    case 'CUSTOMER_SEGMENT':
    case 'TURNAROUND_TYPE':
      if (!Array.isArray(v) || !v.length) return `${c.conditionType}: value must be a non-empty list`;
      return null;
    case 'FIRST_ORDER':
      if (![true, false, 'true', 'false'].includes(v)) return 'FIRST_ORDER: value must be true or false';
      return null;
    case 'ORDER_COUNT':
      if (op === 'between') {
        if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum) || Number(v[0]) > Number(v[1])) return 'ORDER_COUNT: between needs [min, max]';
      } else if (!isNum(v) || Number(v) < 0) {
        return 'ORDER_COUNT: value must be a number ≥ 0';
      }
      if (op && !['gte', 'lte', 'equals', 'between'].includes(op)) return 'ORDER_COUNT: operator must be gte, lte, equals or between';
      return null;
    case 'MINIMUM_SUBTOTAL':
    case 'MAXIMUM_SUBTOTAL':
    case 'MINIMUM_QUANTITY':
    case 'MAXIMUM_QUANTITY':
      if (!isNum(v) || Number(v) < 0) return `${c.conditionType}: value must be a number ≥ 0`;
      return null;
    case 'COLLECTION_DAY':
    case 'DELIVERY_DAY':
      if (!isDayList(v)) return `${c.conditionType}: choose at least one weekday (0-6)`;
      return null;
    case 'BOOKING_TIME':
      if (!v || !normalizeHHMM(v.start) || !normalizeHHMM(v.end)) return 'BOOKING_TIME: value must be { start: "HH:MM", end: "HH:MM" }';
      return null;
    case 'PAYMENT_METHOD':
      if (!Array.isArray(v) || !v.length || !v.every((m) => PAYMENT_METHODS.includes(m))) return `PAYMENT_METHOD: value must be a list of ${PAYMENT_METHODS.join('/')}`;
      return null;
    case 'SCHEDULE': {
      if (!v || typeof v !== 'object') return 'SCHEDULE: value must be { days?, startTime?, endTime? }';
      const hasDays = Array.isArray(v.days) && v.days.length;
      if (hasDays && !isDayList(v.days)) return 'SCHEDULE: days must be weekdays 0-6';
      const hasTime = v.startTime != null || v.endTime != null;
      if (hasTime && (!normalizeHHMM(v.startTime) || !normalizeHHMM(v.endTime))) return 'SCHEDULE: startTime and endTime must both be HH:MM';
      if (!hasDays && !hasTime) return 'SCHEDULE: set days and/or a time window';
      return null;
    }
    case 'COUPON':
      if (!Array.isArray(v) || !v.length || !v.every((x) => String(x).trim())) return 'COUPON: value must be a list of codes';
      return null;
    default:
      return null;
  }
}

// ─── Main evaluator ─────────────────────────────────────────────────────────

/**
 * Evaluate an array of conditions against a PromotionContext.
 *
 * Conditions with logicGroup='ALL' must ALL pass.
 * Conditions with logicGroup='ANY' — at least one must pass.
 *
 * @returns {{ eligible: boolean, pending: boolean, results: Array<{ type, pass, reason? }> }}
 */
function evaluateConditions(conditions, context) {
  if (!conditions || !conditions.length) {
    return { eligible: true, pending: false, results: [] };
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
      return { eligible: false, pending: false, results };
    }
    const result = handler(cond, context);
    results.push({ type: cond.conditionType, ...result });
    if (!result.pass) {
      return { eligible: false, pending: false, results };
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
      return { eligible: false, pending: false, results };
    }
  }

  return { eligible: true, pending: results.some((r) => r.pending), results };
}

module.exports = { evaluateConditions, validateCondition, handlers, CUSTOMER_TYPES, PAYMENT_METHODS };

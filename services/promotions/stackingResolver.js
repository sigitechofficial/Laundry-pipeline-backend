'use strict';

/**
 * Stacking & conflict resolution.
 *
 * Applies eligible promotions to one shared PricingState in a fixed order so
 * combined savings can never exceed what is on the order:
 *   1. Delivery: best single delivery promotion (free delivery / delivery discount)
 *   2. Item scope (item / category / service): in priority order; a line already
 *      discounted by a non-stackable item promotion takes no further item promotions
 *   3. Basket scope: computed on what is left after item promotions. Only one,
 *      unless every basket promotion applied so far and this one are stackable
 *   4. Cashback: one, computed on the final basket
 * Same stackGroup → only the first (highest priority) promotion of that group.
 */

const {
  createPricingState,
  computeBenefit,
  applyBenefit,
  toAdjustments,
  benefitScope,
  remainingSubtotalMinor,
} = require('./benefitHandlers');
const { fromMinor } = require('./moneyUtils');

function priorityOf(promo) {
  const p = Number(promo.priority);
  return Number.isFinite(p) ? p : 50;
}

function byPriority(a, b) {
  return priorityOf(b.promotion) - priorityOf(a.promotion) || Number(a.promotion.id) - Number(b.promotion.id);
}

function stackingReject(entry, reason) {
  return { ...entry, reasons: [{ type: 'STACKING', pass: false, code: 'PROMOTION_NOT_COMBINABLE', reason }] };
}

/**
 * @param {Array<{ promotion, zoneOverride?, coupon? }>} eligible
 * @param {object} context PromotionContext (basket)
 * @returns {{ applied: Array, rejected: Array, state, subtotalMinor, totalSavingMinor, cashbackMinor }}
 */
function resolveAndApply(eligible, context) {
  const state = createPricingState(context);
  const subtotalMinor = remainingSubtotalMinor(state);
  const sorted = [...eligible].sort(byPriority);
  const applied = [];
  const rejected = [];
  const usedStackGroups = new Set();

  const record = (entry, benefit) => {
    applyBenefit(entry.promotion, state, benefit);
    if (entry.promotion.stackGroup) usedStackGroups.add(entry.promotion.stackGroup);
    applied.push({
      ...entry,
      benefit: {
        totalSavingMinor: benefit.totalSavingMinor,
        totalSaving: fromMinor(benefit.totalSavingMinor),
        cashbackMinor: benefit.cashbackMinor,
        cashbackAmount: fromMinor(benefit.cashbackMinor),
        adjustments: toAdjustments(state, benefit),
      },
    });
  };
  const groupTaken = (entry) => entry.promotion.stackGroup && usedStackGroups.has(entry.promotion.stackGroup);
  const noBenefit = (entry) => ({
    ...entry,
    reasons: [{ type: 'NO_BENEFIT', pass: false, code: 'PROMOTION_NO_BENEFIT', reason: 'Nothing left on the order for this promotion to discount' }],
  });

  // 1. Delivery — best saving wins
  const delivery = sorted.filter((e) => benefitScope(e.promotion.benefitType) === 'delivery');
  let bestDelivery = null;
  for (const entry of delivery) {
    if (groupTaken(entry)) { rejected.push(stackingReject(entry, `Another promotion in group "${entry.promotion.stackGroup}" applied`)); continue; }
    const benefit = computeBenefit(entry.promotion, state, entry);
    if (!bestDelivery || benefit.totalSavingMinor > bestDelivery.benefit.totalSavingMinor) {
      if (bestDelivery) rejected.push(stackingReject(bestDelivery.entry, 'A better delivery offer applied'));
      bestDelivery = { entry, benefit };
    } else {
      rejected.push(stackingReject(entry, 'A better delivery offer applied'));
    }
  }
  if (bestDelivery) {
    if (bestDelivery.benefit.totalSavingMinor > 0) record(bestDelivery.entry, bestDelivery.benefit);
    else rejected.push(noBenefit(bestDelivery.entry));
  }

  // 2. Item scope
  for (const entry of sorted.filter((e) => benefitScope(e.promotion.benefitType) === 'item')) {
    if (groupTaken(entry)) { rejected.push(stackingReject(entry, `Another promotion in group "${entry.promotion.stackGroup}" applied`)); continue; }
    const benefit = computeBenefit(entry.promotion, state, entry);
    if (benefit.totalSavingMinor > 0) record(entry, benefit);
    else rejected.push(noBenefit(entry));
  }

  // 3. Basket scope
  let basketApplied = false;
  let allAppliedStackable = true;
  for (const entry of sorted.filter((e) => benefitScope(e.promotion.benefitType) === 'basket')) {
    if (groupTaken(entry)) { rejected.push(stackingReject(entry, `Another promotion in group "${entry.promotion.stackGroup}" applied`)); continue; }
    if (basketApplied && !(allAppliedStackable && entry.promotion.stackable)) {
      rejected.push(stackingReject(entry, 'Only one order-level discount can be used'));
      continue;
    }
    const benefit = computeBenefit(entry.promotion, state, entry);
    if (benefit.totalSavingMinor <= 0) { rejected.push(noBenefit(entry)); continue; }
    record(entry, benefit);
    basketApplied = true;
    allAppliedStackable = allAppliedStackable && Boolean(entry.promotion.stackable);
  }

  // 4. Cashback — one
  let cashbackApplied = false;
  for (const entry of sorted.filter((e) => benefitScope(e.promotion.benefitType) === 'cashback')) {
    if (groupTaken(entry) || cashbackApplied) { rejected.push(stackingReject(entry, 'Only one cashback offer can be used')); continue; }
    const benefit = computeBenefit(entry.promotion, state, entry);
    if (benefit.cashbackMinor <= 0) { rejected.push(noBenefit(entry)); continue; }
    record(entry, benefit);
    cashbackApplied = true;
  }

  const totalSavingMinor = applied.reduce((s, a) => s + a.benefit.totalSavingMinor, 0);
  const cashbackMinor = applied.reduce((s, a) => s + a.benefit.cashbackMinor, 0);
  return { applied, rejected, state, subtotalMinor, totalSavingMinor, cashbackMinor };
}

// ─── Conflict detection (admin warning) ─────────────────────────────────────

function isDeliveryScope(promo) {
  return benefitScope(promo.benefitType) === 'delivery';
}

function isItemScope(promo) {
  return benefitScope(promo.benefitType) === 'item';
}

function isBasketScope(promo) {
  return benefitScope(promo.benefitType) === 'basket';
}

/**
 * Pairs of promotions that will compete when both qualify.
 * @param {Array<object>} promotions - live promotions
 * @returns {Array<{ a, b, reason }>}
 */
function detectConflicts(promotions) {
  const conflicts = [];
  for (let i = 0; i < promotions.length; i++) {
    for (let j = i + 1; j < promotions.length; j++) {
      const a = promotions[i];
      const b = promotions[j];
      if (!zonesOverlap(a, b) || !datesOverlap(a, b)) continue;

      if (a.stackGroup && a.stackGroup === b.stackGroup) {
        conflicts.push({ a, b, reason: `Same stack group "${a.stackGroup}" with overlapping zones/dates` });
      } else if (isBasketScope(a) && isBasketScope(b) && !(a.stackable && b.stackable)) {
        conflicts.push({ a, b, reason: 'Two order-level discounts with overlapping zones/dates — only the higher priority one will apply' });
      } else if (isDeliveryScope(a) && isDeliveryScope(b)) {
        conflicts.push({ a, b, reason: 'Two delivery offers with overlapping zones/dates — only the better one will apply' });
      }
    }
  }
  return conflicts;
}

function zonesOverlap(a, b) {
  const ids = (p) => new Set(Array.isArray(p.zoneIds) ? p.zoneIds.map(Number) : []);
  if (a.zoneScopeMode === 'all' || b.zoneScopeMode === 'all') return true;
  if (a.zoneScopeMode === 'excluded' || b.zoneScopeMode === 'excluded') return true; // excluded lists rarely cover everything
  const aIds = ids(a);
  return [...ids(b)].some((id) => aIds.has(id));
}

function datesOverlap(a, b) {
  const aStart = a.startDate ? new Date(a.startDate) : new Date(0);
  const aEnd = a.endDate ? new Date(a.endDate) : new Date('2999-12-31');
  const bStart = b.startDate ? new Date(b.startDate) : new Date(0);
  const bEnd = b.endDate ? new Date(b.endDate) : new Date('2999-12-31');
  return aStart <= bEnd && bStart <= aEnd;
}

module.exports = { resolveAndApply, detectConflicts, isDeliveryScope, isItemScope, isBasketScope, priorityOf };

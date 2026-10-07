'use strict';

/**
 * Stacking & conflict resolver.
 *
 * Determines which promotions actually apply when multiple qualify.
 *
 * Rules:
 *  - Item promos + basket promos: can stack (different scope)
 *  - Two basket promos: highest priority wins (not stackable)
 *  - Promo + free delivery: always stacks (different scope)
 *  - Same stackGroup: only highest priority
 *  - stackable=true: can combine with others
 *
 * Input: array of { promotion, benefit } where benefit = { adjustments, totalSaving }
 * Output: filtered array in application order
 */

/**
 * Resolve which promotions to apply from a list of eligible candidates.
 *
 * @param {Array<{ promotion, benefit, evaluation }>} candidates
 * @returns {Array<{ promotion, benefit }>} — ordered list of promotions to apply
 */
function resolveStacking(candidates) {
  if (!candidates.length) return [];

  // Sort by priority descending (higher priority = applied first)
  const sorted = [...candidates].sort(
    (a, b) => (b.promotion.priority || 50) - (a.promotion.priority || 50)
  );

  // Group by scope to handle stacking rules
  const deliveryPromos = sorted.filter((c) => isDeliveryScope(c.promotion));
  const itemPromos = sorted.filter((c) => isItemScope(c.promotion));
  const basketPromos = sorted.filter((c) => isBasketScope(c.promotion));

  const result = [];
  const usedStackGroups = new Set();

  // 1. Delivery promos: pick best one
  if (deliveryPromos.length) {
    const best = pickBestInGroup(deliveryPromos);
    if (best) result.push(best);
  }

  // 2. Item-level promos: stackable by default (different line items)
  for (const c of itemPromos) {
    const group = c.promotion.stackGroup;
    if (group && usedStackGroups.has(group)) continue;
    result.push(c);
    if (group) usedStackGroups.add(group);
  }

  // 3. Basket-level promos: only one unless explicitly stackable
  if (basketPromos.length) {
    let basketApplied = false;
    for (const c of basketPromos) {
      const group = c.promotion.stackGroup;
      if (group && usedStackGroups.has(group)) continue;

      if (!basketApplied || c.promotion.stackable) {
        result.push(c);
        basketApplied = true;
        if (group) usedStackGroups.add(group);
        if (!c.promotion.stackable) break; // non-stackable basket = only one
      }
    }
  }

  return result;
}

// ─── Scope classification ───────────────────────────────────────────────────

function isDeliveryScope(promo) {
  return promo.benefitType === 'free_delivery' || promo.benefitType === 'delivery_discount' || promo.targetType === 'delivery';
}

function isItemScope(promo) {
  return ['item_discount', 'category_discount', 'service_discount'].includes(promo.benefitType) ||
    ['subCategory', 'addon', 'category', 'service'].includes(promo.targetType);
}

function isBasketScope(promo) {
  return !isDeliveryScope(promo) && !isItemScope(promo);
}

function pickBestInGroup(candidates) {
  if (!candidates.length) return null;
  // Best = highest saving
  return candidates.reduce((best, c) =>
    (c.benefit?.totalSaving || 0) > (best.benefit?.totalSaving || 0) ? c : best
  );
}

/**
 * Detect potential conflicts for admin warning.
 *
 * @param {Array<object>} promotions - All active promotions
 * @returns {Array<{ a, b, reason }>} - Pairs that could conflict
 */
function detectConflicts(promotions) {
  const conflicts = [];
  for (let i = 0; i < promotions.length; i++) {
    for (let j = i + 1; j < promotions.length; j++) {
      const a = promotions[i];
      const b = promotions[j];

      // Same stack group + overlapping dates + overlapping zones
      if (a.stackGroup && a.stackGroup === b.stackGroup && zonesOverlap(a, b) && datesOverlap(a, b)) {
        conflicts.push({ a, b, reason: `Same stack group "${a.stackGroup}" with overlapping zones/dates` });
      }

      // Both basket-scoped + neither stackable + overlapping
      if (isBasketScope(a) && isBasketScope(b) && !a.stackable && !b.stackable && zonesOverlap(a, b) && datesOverlap(a, b)) {
        conflicts.push({ a, b, reason: 'Both are non-stackable basket promotions with overlapping zones/dates' });
      }
    }
  }
  return conflicts;
}

function zonesOverlap(a, b) {
  if (a.zoneScopeMode === 'all' || b.zoneScopeMode === 'all') return true;
  const aIds = new Set(Array.isArray(a.zoneIds) ? a.zoneIds.map(Number) : []);
  const bIds = Array.isArray(b.zoneIds) ? b.zoneIds.map(Number) : [];
  return bIds.some((id) => aIds.has(id));
}

function datesOverlap(a, b) {
  if (!a.startDate && !b.startDate) return true;
  const aStart = a.startDate ? new Date(a.startDate) : new Date(0);
  const aEnd = a.endDate ? new Date(a.endDate) : new Date('2099-12-31');
  const bStart = b.startDate ? new Date(b.startDate) : new Date(0);
  const bEnd = b.endDate ? new Date(b.endDate) : new Date('2099-12-31');
  return aStart <= bEnd && bStart <= aEnd;
}

module.exports = { resolveStacking, detectConflicts, isDeliveryScope, isItemScope, isBasketScope };

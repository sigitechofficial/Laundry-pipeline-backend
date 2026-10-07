'use strict';

/**
 * Enterprise Promotion Engine tests.
 * Run: node tests/promotionEngine.test.js
 */

const assert = require('assert');

// ─── Money Utils ────────────────────────────────────────────────────────────

const { toDecimal, money, toMinor, fromMinor, percentOf, addMoney, subtractMoney, allocateProportionally } = require('../services/promotions/moneyUtils');

assert.strictEqual(money(10), '10.00');
assert.strictEqual(money(10.126), '10.13');
assert.strictEqual(money(null), '0.00');
assert.strictEqual(toMinor(10.99), 1099);
assert.strictEqual(fromMinor(1099), 10.99);
assert.strictEqual(percentOf(100, 20), 20);
assert.strictEqual(percentOf(33.33, 15), 5);     // 33.33 * 15% = 4.9995 → rounded to 5.00
assert.strictEqual(addMoney(10.1, 20.2), 30.3);
assert.strictEqual(subtractMoney(10, 3), 7);
assert.strictEqual(subtractMoney(3, 10), 0);       // floor at 0

const alloc = allocateProportionally(10, [20, 30, 50]);
assert.strictEqual(alloc.reduce((s, v) => s + Math.round(v * 100), 0), 1000, 'allocation sums to total');

console.log('✅ Money utils: all passed');

// ─── Condition Evaluator ────────────────────────────────────────────────────

const { evaluateConditions } = require('../services/promotions/conditionEvaluator');

// Test FIRST_ORDER
{
  const conditions = [{ conditionType: 'FIRST_ORDER', operator: 'equals', value: true, logicGroup: 'ALL' }];
  const ctx1 = { customer: { isFirstOrder: true } };
  const ctx2 = { customer: { isFirstOrder: false, orderCount: 5 } };
  assert.strictEqual(evaluateConditions(conditions, ctx1).eligible, true, 'first order passes');
  assert.strictEqual(evaluateConditions(conditions, ctx2).eligible, false, 'not first order fails');
}

// Test MINIMUM_SUBTOTAL
{
  const conditions = [{ conditionType: 'MINIMUM_SUBTOTAL', operator: 'gte', value: 30, logicGroup: 'ALL' }];
  const ctx1 = { basket: { subtotal: 35 } };
  const ctx2 = { basket: { subtotal: 25 } };
  assert.strictEqual(evaluateConditions(conditions, ctx1).eligible, true, 'above minimum passes');
  assert.strictEqual(evaluateConditions(conditions, ctx2).eligible, false, 'below minimum fails');
}

// Test ZONE
{
  const conditions = [{ conditionType: 'ZONE', operator: 'in', value: [1, 2, 3], logicGroup: 'ALL' }];
  const ctx1 = { zone: { id: 2 } };
  const ctx2 = { zone: { id: 5 } };
  assert.strictEqual(evaluateConditions(conditions, ctx1).eligible, true, 'zone 2 in [1,2,3]');
  assert.strictEqual(evaluateConditions(conditions, ctx2).eligible, false, 'zone 5 not in [1,2,3]');
}

// Test SERVICE condition
{
  const conditions = [{ conditionType: 'SERVICE', operator: 'in', value: [10], logicGroup: 'ALL' }];
  const ctx1 = { basket: { lineItems: [{ serviceId: 10, price: 5, qty: 1 }] } };
  const ctx2 = { basket: { lineItems: [{ serviceId: 99, price: 5, qty: 1 }] } };
  assert.strictEqual(evaluateConditions(conditions, ctx1).eligible, true, 'service 10 in basket');
  assert.strictEqual(evaluateConditions(conditions, ctx2).eligible, false, 'service 99 not required');
}

// Test COLLECTION_DAY
{
  const conditions = [{ conditionType: 'COLLECTION_DAY', operator: 'in', value: [1, 2, 3], logicGroup: 'ALL' }];
  const ctx1 = { timing: { collectionDay: 2 } };
  const ctx2 = { timing: { collectionDay: 6 } };
  assert.strictEqual(evaluateConditions(conditions, ctx1).eligible, true, 'Tuesday matches [1,2,3]');
  assert.strictEqual(evaluateConditions(conditions, ctx2).eligible, false, 'Saturday not in [1,2,3]');
}

// Test multiple conditions (ALL)
{
  const conditions = [
    { conditionType: 'FIRST_ORDER', operator: 'equals', value: true, logicGroup: 'ALL' },
    { conditionType: 'MINIMUM_SUBTOTAL', operator: 'gte', value: 20, logicGroup: 'ALL' },
  ];
  const ctx = { customer: { isFirstOrder: true }, basket: { subtotal: 25 } };
  assert.strictEqual(evaluateConditions(conditions, ctx).eligible, true, 'both conditions pass');

  const ctx2 = { customer: { isFirstOrder: true }, basket: { subtotal: 15 } };
  assert.strictEqual(evaluateConditions(conditions, ctx2).eligible, false, 'subtotal fails');
}

// Empty conditions = eligible
{
  assert.strictEqual(evaluateConditions([], {}).eligible, true, 'empty conditions = eligible');
}

console.log('✅ Condition evaluator: all passed');

// ─── Benefit Handlers ───────────────────────────────────────────────────────

const { calculateBenefit } = require('../services/promotions/benefitHandlers');

// Percentage discount
{
  const promo = { benefitType: 'percentage_discount', discountValue: 20, maxDiscountCap: 15 };
  const ctx = { basket: { subtotal: 100, lineItems: [{ subCategoryId: 1, price: 60, qty: 1 }, { subCategoryId: 2, price: 40, qty: 1 }] } };
  const result = calculateBenefit(promo, ctx);
  assert.strictEqual(result.totalSaving, 15, '20% of 100 = 20, capped at 15');
  assert.strictEqual(result.adjustments.length, 2, 'allocated to 2 lines');
}

// Percentage without cap
{
  const promo = { benefitType: 'percentage_discount', discountValue: 10, maxDiscountCap: null };
  const ctx = { basket: { subtotal: 50, lineItems: [{ subCategoryId: 1, price: 50, qty: 1 }] } };
  const result = calculateBenefit(promo, ctx);
  assert.strictEqual(result.totalSaving, 5, '10% of 50 = 5');
}

// Fixed amount discount
{
  const promo = { benefitType: 'fixed_amount_discount', discountValue: 8 };
  const ctx = { basket: { subtotal: 50, lineItems: [{ subCategoryId: 1, price: 30, qty: 1 }, { subCategoryId: 2, price: 20, qty: 1 }] } };
  const result = calculateBenefit(promo, ctx);
  assert.strictEqual(result.totalSaving, 8, '£8 off basket');
}

// Fixed amount > subtotal
{
  const promo = { benefitType: 'fixed_amount_discount', discountValue: 100 };
  const ctx = { basket: { subtotal: 50, lineItems: [{ subCategoryId: 1, price: 50, qty: 1 }] } };
  const result = calculateBenefit(promo, ctx);
  assert.strictEqual(result.totalSaving, 50, 'capped at subtotal');
}

// Free delivery
{
  const promo = { benefitType: 'free_delivery' };
  const ctx = { basket: { subtotal: 50, deliveryFee: 3.50 } };
  const result = calculateBenefit(promo, ctx);
  assert.strictEqual(result.totalSaving, 3.50, 'free delivery saves £3.50');
  assert.strictEqual(result.adjustments[0].lineType, 'delivery');
}

// First order discount (delegates to percentage)
{
  const promo = { benefitType: 'first_order_discount', discountValue: 25, maxDiscountCap: 10 };
  const ctx = { basket: { subtotal: 60, lineItems: [{ subCategoryId: 1, price: 60, qty: 1 }] } };
  const result = calculateBenefit(promo, ctx);
  assert.strictEqual(result.totalSaving, 10, '25% of 60 = 15, capped at 10');
}

// Zone override
{
  const promo = { benefitType: 'percentage_discount', discountValue: 20, maxDiscountCap: 15, currency: 'GBP' };
  const ctx = { basket: { subtotal: 100, lineItems: [{ subCategoryId: 1, price: 100, qty: 1 }] } };
  const zoneOverride = { discountValue: 10, maxDiscountCap: 5 };
  const result = calculateBenefit(promo, ctx, { zoneOverride });
  assert.strictEqual(result.totalSaving, 5, 'zone override: 10% of 100 = 10, capped at 5');
}

console.log('✅ Benefit handlers: all passed');

// ─── Stacking Resolver ──────────────────────────────────────────────────────

const { resolveStacking, detectConflicts } = require('../services/promotions/stackingResolver');

// Two basket promos — only highest priority
{
  const candidates = [
    { promotion: { id: 1, benefitType: 'percentage_discount', targetType: 'basket', priority: 80, stackable: false }, benefit: { totalSaving: 10 } },
    { promotion: { id: 2, benefitType: 'fixed_amount_discount', targetType: 'basket', priority: 50, stackable: false }, benefit: { totalSaving: 5 } },
  ];
  const result = resolveStacking(candidates);
  assert.strictEqual(result.length, 1, 'only one basket promo');
  assert.strictEqual(result[0].promotion.id, 1, 'higher priority wins');
}

// Item promo + basket promo = both apply
{
  const candidates = [
    { promotion: { id: 1, benefitType: 'item_discount', targetType: 'subCategory', priority: 50, stackable: false }, benefit: { totalSaving: 3 } },
    { promotion: { id: 2, benefitType: 'percentage_discount', targetType: 'basket', priority: 50, stackable: false }, benefit: { totalSaving: 10 } },
  ];
  const result = resolveStacking(candidates);
  assert.strictEqual(result.length, 2, 'item + basket both apply');
}

// Delivery promo + basket promo = both apply
{
  const candidates = [
    { promotion: { id: 1, benefitType: 'free_delivery', targetType: 'delivery', priority: 20 }, benefit: { totalSaving: 3.5 } },
    { promotion: { id: 2, benefitType: 'percentage_discount', targetType: 'basket', priority: 80, stackable: false }, benefit: { totalSaving: 10 } },
  ];
  const result = resolveStacking(candidates);
  assert.strictEqual(result.length, 2, 'delivery + basket both apply');
}

// Conflict detection
{
  const promos = [
    { id: 1, stackGroup: 'welcome', zoneScopeMode: 'all', zoneIds: [], startDate: null, endDate: null, benefitType: 'percentage_discount', targetType: 'basket', stackable: false },
    { id: 2, stackGroup: 'welcome', zoneScopeMode: 'all', zoneIds: [], startDate: null, endDate: null, benefitType: 'fixed_amount_discount', targetType: 'basket', stackable: false },
  ];
  const conflicts = detectConflicts(promos);
  assert.strictEqual(conflicts.length > 0, true, 'same stack group detected as conflict');
}

console.log('✅ Stacking resolver: all passed');

// ─── Allocation correctness ────────────────────────────────────────────────

{
  const alloc = allocateProportionally(10, [30, 70]);
  const sumMinor = Math.round(alloc[0] * 100) + Math.round(alloc[1] * 100);
  assert.strictEqual(sumMinor, 1000, 'proportional allocation sums exactly');
}

{
  const alloc = allocateProportionally(7, [10, 10, 10]);
  const sumMinor = alloc.reduce((s, v) => s + Math.round(v * 100), 0);
  assert.strictEqual(sumMinor, 700, 'three-way allocation sums exactly');
}

console.log('✅ Allocation correctness: all passed');
console.log('\n🎉 All enterprise promotion engine tests passed!');

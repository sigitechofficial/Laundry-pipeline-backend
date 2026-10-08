'use strict';

/**
 * Enterprise Promotion Engine tests (pure logic, no DB).
 * Run: node tests/promotionEngine.test.js
 */

const assert = require('assert');

// ─── Money Utils ────────────────────────────────────────────────────────────

const {
  money, toMinor, fromMinor, percentOf, addMoney, subtractMoney, allocateProportionally, percentOfMinor, allocateMinor,
} = require('../services/promotions/moneyUtils');

assert.strictEqual(money(10), '10.00');
assert.strictEqual(money(10.126), '10.13');
assert.strictEqual(money(null), '0.00');
assert.strictEqual(toMinor(10.99), 1099);
assert.strictEqual(fromMinor(1099), 10.99);
assert.strictEqual(percentOf(100, 20), 20);
assert.strictEqual(percentOf(33.33, 15), 5);
assert.strictEqual(addMoney(10.1, 20.2), 30.3);
assert.strictEqual(subtractMoney(10, 3), 7);
assert.strictEqual(subtractMoney(3, 10), 0);
assert.strictEqual(percentOfMinor(3333, 15), 500);

const alloc = allocateProportionally(10, [20, 30, 50]);
assert.strictEqual(alloc.reduce((s, v) => s + Math.round(v * 100), 0), 1000, 'allocation sums to total');

// allocateMinor: exact sum, never above a weight (property test)
for (let run = 0; run < 2000; run++) {
  const weights = Array.from({ length: 1 + (run % 6) }, () => Math.floor(Math.random() * 5000));
  const sum = weights.reduce((s, w) => s + w, 0);
  const total = Math.floor(Math.random() * (sum + 1));
  const shares = allocateMinor(total, weights);
  assert.strictEqual(shares.reduce((s, v) => s + v, 0), sum ? total : 0, 'allocateMinor sums exactly');
  shares.forEach((v, i) => assert.ok(v >= 0 && v <= weights[i], 'share within its weight'));
}
assert.deepStrictEqual(allocateMinor(500, [100, 100]), [100, 100], 'total above weights is clamped');

console.log('✅ Money utils: all passed');

// ─── Zone-local time ────────────────────────────────────────────────────────

const { localClock, isWithinWindow, normalizeHHMM, localDay } = require('../services/promotions/promotionTime');

{
  // 2026-07-04 is a Saturday. 23:30 UTC in summer = 00:30 Sunday in London.
  const t = new Date('2026-07-04T23:30:00Z');
  assert.deepStrictEqual(localClock(t, 'Europe/London'), { day: 0, hhmm: '00:30' }, 'London is UTC+1 in summer');
  assert.deepStrictEqual(localClock(t, 'UTC'), { day: 6, hhmm: '23:30' });
  assert.strictEqual(normalizeHHMM('17:00:00'), '17:00');
  assert.strictEqual(normalizeHHMM('25:00'), null);
  assert.strictEqual(isWithinWindow('09:00', '09:00:00', '17:00:00'), true, 'start minute is inside');
  assert.strictEqual(isWithinWindow('23:15', '22:00', '02:00'), true, 'overnight window, before midnight');
  assert.strictEqual(isWithinWindow('01:30', '22:00', '02:00'), true, 'overnight window, after midnight');
  assert.strictEqual(isWithinWindow('12:00', '22:00', '02:00'), false, 'overnight window, midday');
  assert.strictEqual(localDay('2026-10-10', 'Europe/London'), 6, 'date-only Saturday');
}

console.log('✅ Promotion time: all passed');

// ─── Condition Evaluator ────────────────────────────────────────────────────

const { evaluateConditions, validateCondition } = require('../services/promotions/conditionEvaluator');

{
  const c = [{ conditionType: 'FIRST_ORDER', operator: 'equals', value: true, logicGroup: 'ALL' }];
  assert.strictEqual(evaluateConditions(c, { customer: { orderCount: 0 } }).eligible, true, 'first order passes');
  assert.strictEqual(evaluateConditions(c, { customer: { orderCount: 5, isFirstOrder: true } }).eligible, false, 'orderCount wins over a claimed isFirstOrder');
}
{
  const c = [{ conditionType: 'MINIMUM_SUBTOTAL', operator: 'gte', value: 30, logicGroup: 'ALL' }];
  assert.strictEqual(evaluateConditions(c, { basket: { subtotal: 30 } }).eligible, true, 'exactly at minimum passes');
  const r = evaluateConditions(c, { basket: { subtotal: 29.99 } });
  assert.strictEqual(r.eligible, false, '£0.01 below minimum fails');
  assert.strictEqual(r.results[0].code, 'PROMOTION_MIN_SPEND_NOT_MET');
}
{
  const c = [{ conditionType: 'ZONE', operator: 'in', value: [1, 2, 3], logicGroup: 'ALL' }];
  assert.strictEqual(evaluateConditions(c, { zone: { id: 2 } }).eligible, true);
  assert.strictEqual(evaluateConditions(c, { zone: { id: 5 } }).eligible, false);
}
{
  const c = [{ conditionType: 'SCHEDULE', operator: 'between', value: { days: [0, 6] }, logicGroup: 'ALL' }];
  const satLondon = { zone: { timezone: 'Europe/London' }, currentTime: new Date('2026-10-10T12:00:00Z') };
  const friLateUtcSatLondon = { zone: { timezone: 'Europe/London' }, currentTime: new Date('2026-10-09T23:30:00Z') };
  const wed = { zone: { timezone: 'Europe/London' }, currentTime: new Date('2026-10-07T12:00:00Z') };
  assert.strictEqual(evaluateConditions(c, satLondon).eligible, true, 'weekend promo on Saturday');
  assert.strictEqual(evaluateConditions(c, friLateUtcSatLondon).eligible, true, 'zone-local day used, not UTC');
  assert.strictEqual(evaluateConditions(c, wed).eligible, false, 'weekend promo on Wednesday');
}
{
  const c = [{ conditionType: 'PAYMENT_METHOD', operator: 'in', value: ['card'], logicGroup: 'ALL' }];
  const browsing = evaluateConditions(c, {});
  assert.strictEqual(browsing.eligible, true, 'unknown payment method passes while browsing');
  assert.strictEqual(browsing.pending, true, '…but is flagged pending');
  assert.strictEqual(evaluateConditions(c, { strict: true }).eligible, false, 'strict (checkout) fails unknown payment method');
  assert.strictEqual(evaluateConditions(c, { paymentMethod: 'cash' }).eligible, false);
  assert.strictEqual(evaluateConditions(c, { paymentMethod: 'card' }).eligible, true);
}
{
  const c = [{ conditionType: 'COUPON', operator: 'in', value: ['summer20'], logicGroup: 'ALL' }];
  assert.strictEqual(evaluateConditions(c, { couponCodes: ['SUMMER20'] }).eligible, true, 'coupon match is case-insensitive');
  assert.strictEqual(evaluateConditions(c, { couponCodes: [12345] }).eligible, false, 'non-string codes do not crash');
}
{
  const c = [
    { conditionType: 'COLLECTION_DAY', operator: 'in', value: [1], logicGroup: 'ANY' },
    { conditionType: 'COLLECTION_DAY', operator: 'in', value: [2], logicGroup: 'ANY' },
  ];
  assert.strictEqual(evaluateConditions(c, { timing: { collectionDay: 2 } }).eligible, true, 'ANY group');
  assert.strictEqual(evaluateConditions(c, { timing: { collectionDay: 3 } }).eligible, false);
}
assert.strictEqual(evaluateConditions([], {}).eligible, true, 'empty conditions = eligible');

// Admin validation rejects conditions that can never pass
assert.ok(validateCondition({ conditionType: 'PAYMENT_METHOD', operator: 'equals', value: true }), 'PAYMENT_METHOD=true rejected');
assert.strictEqual(validateCondition({ conditionType: 'PAYMENT_METHOD', operator: 'in', value: ['card'] }), null);
assert.ok(validateCondition({ conditionType: 'MINIMUM_SUBTOTAL', operator: 'gte', value: true }), 'boolean subtotal rejected');
assert.ok(validateCondition({ conditionType: 'SERVICE', operator: 'in', value: [] }), 'empty id list rejected');
assert.ok(validateCondition({ conditionType: 'ORDER_COUNT', operator: 'between', value: [5, 2] }), 'bad between rejected');
assert.strictEqual(validateCondition({ conditionType: 'CUSTOMER_TYPE', operator: 'in', value: ['returning'] }), null);
assert.ok(validateCondition({ conditionType: 'NOPE', value: 1 }), 'unknown type rejected');

console.log('✅ Condition evaluator: all passed');

// ─── Benefit Handlers ───────────────────────────────────────────────────────

const { calculateBenefit } = require('../services/promotions/benefitHandlers');

const basket60 = {
  basket: {
    subtotal: 60, deliveryFee: 3,
    lineItems: [
      { subCategoryId: 1, categoryId: 10, serviceId: 100, price: 20, qty: 1 },
      { subCategoryId: 2, categoryId: 10, serviceId: 100, price: 20, qty: 1 },
      { subCategoryId: 3, categoryId: 11, serviceId: 101, price: 10, qty: 2 },
    ],
  },
};

{
  const r = calculateBenefit({ benefitType: 'percentage_discount', discountValue: 20, maxDiscountCap: 10 }, basket60);
  assert.strictEqual(r.totalSaving, 10, '20% of 60 = 12, capped at 10');
  assert.strictEqual(r.adjustments.reduce((s, a) => s + a.amountMinor, 0), -1000, 'line allocations sum to the saving');
}
{
  const r = calculateBenefit({ benefitType: 'basket_discount', discountValue: 50, discountMode: 'amount' }, basket60);
  assert.strictEqual(r.totalSaving, 50, 'basket_discount amount mode: £50 off (not 50%)');
  const p = calculateBenefit({ benefitType: 'basket_discount', discountValue: 50, discountMode: 'percent' }, basket60);
  assert.strictEqual(p.totalSaving, 30, 'basket_discount percent mode: 50% of 60');
}
{
  const r = calculateBenefit({ benefitType: 'fixed_amount_discount', discountValue: 100 }, basket60);
  assert.strictEqual(r.totalSaving, 60, 'fixed discount capped at subtotal');
}
{
  const r = calculateBenefit({ benefitType: 'category_discount', discountValue: 50, maxDiscountCap: 5, targetIds: [10] }, basket60);
  assert.strictEqual(r.totalSaving, 5, 'cap applies to the whole promotion, not per line');
  assert.strictEqual(r.adjustments.length, 2, 'spread over the two matching lines');
}
{
  const r = calculateBenefit({ benefitType: 'item_discount', discountValue: 50, targetType: 'category', targetIds: [10] }, basket60);
  assert.strictEqual(r.totalSaving, 20, 'item_discount can target a category');
  const each = calculateBenefit({ benefitType: 'item_discount', discountMode: 'amount', discountValue: 1.5, targetType: 'subCategory', targetIds: [3] }, basket60);
  assert.strictEqual(each.totalSaving, 3, '£1.50 off each of 2 units');
}
{
  const r = calculateBenefit({ benefitType: 'category_discount', discountValue: 100, targetIds: [10] }, {
    basket: { lineItems: [{ subCategoryId: 1, categoryId: 10, price: 0.1, qty: 1 }, { subCategoryId: 2, categoryId: 10, price: 0.2, qty: 1 }] },
  });
  assert.strictEqual(r.totalSaving, 0.3, 'no floating point drift');
}
{
  const r = calculateBenefit({ benefitType: 'fixed_price', discountValue: 45 }, basket60);
  assert.strictEqual(r.totalSaving, 15, 'basket sold for £45');
}
{
  const r = calculateBenefit({ benefitType: 'free_delivery' }, basket60);
  assert.strictEqual(r.totalSaving, 3);
  assert.strictEqual(r.adjustments[0].lineType, 'delivery');
}
{
  const r = calculateBenefit({ benefitType: 'cashback', discountValue: 100, maxDiscountCap: 5 }, basket60);
  assert.strictEqual(r.totalSaving, 0, 'cashback does not reduce the order');
  assert.strictEqual(r.cashbackAmount, 5, 'cashback capped');
}
{
  const r = calculateBenefit({ benefitType: 'percentage_discount', discountValue: 20, maxDiscountCap: 15 }, basket60, { zoneOverride: { discountValue: 10, maxDiscountCap: 5 } });
  assert.strictEqual(r.totalSaving, 5, 'zone override: 10% of 60 = 6, capped at 5');
}
{
  const r = calculateBenefit({ benefitType: 'buy_x_get_y', discountValue: 1 }, basket60);
  assert.strictEqual(r.totalSaving, 0, 'unsupported type gives nothing');
}

console.log('✅ Benefit handlers: all passed');

// ─── Stacking resolver ──────────────────────────────────────────────────────

const { resolveAndApply, detectConflicts } = require('../services/promotions/stackingResolver');
const entry = (id, p) => ({ promotion: { id, priority: 50, stackable: false, ...p } });

{
  // The £126-on-£60 bug: item + item + basket must never exceed the basket
  const r = resolveAndApply([
    entry(1, { benefitType: 'category_discount', discountValue: 80, targetIds: [10] }),
    entry(2, { benefitType: 'service_discount', discountValue: 80, targetIds: [100] }),
    entry(3, { benefitType: 'percentage_discount', discountValue: 50 }),
  ], basket60);
  assert.ok(r.totalSavingMinor <= 6000, `total ${r.totalSavingMinor} must be ≤ 6000`);
  assert.deepStrictEqual(r.applied.map((a) => a.promotion.id), [1, 3], 'second non-stackable item promo skips already-discounted lines; basket applies to the rest');
  assert.strictEqual(r.totalSavingMinor, 3200 + 1400, '80% of £40 + 50% of remaining £28');
  assert.strictEqual(r.rejected[0].promotion.id, 2, 'loser is reported, not silently dropped');
}
{
  const r = resolveAndApply([
    entry(1, { benefitType: 'percentage_discount', discountValue: 10, priority: 80 }),
    entry(2, { benefitType: 'fixed_amount_discount', discountValue: 5, priority: 50 }),
  ], basket60);
  assert.deepStrictEqual(r.applied.map((a) => a.promotion.id), [1], 'two basket promos: higher priority wins');
  assert.strictEqual(r.rejected[0].reasons[0].code, 'PROMOTION_NOT_COMBINABLE');
}
{
  const r = resolveAndApply([
    entry(1, { benefitType: 'percentage_discount', discountValue: 10, stackable: true }),
    entry(2, { benefitType: 'fixed_amount_discount', discountValue: 5, stackable: true }),
  ], basket60);
  assert.strictEqual(r.applied.length, 2, 'two stackable basket promos both apply');
  assert.strictEqual(r.totalSavingMinor, 600 + 500, '10% of 60, then £5 off the rest');
}
{
  const r = resolveAndApply([
    entry(1, { benefitType: 'percentage_discount', discountValue: 10, priority: 0 }),
    entry(2, { benefitType: 'percentage_discount', discountValue: 20, priority: 1 }),
  ], basket60);
  assert.strictEqual(r.applied[0].promotion.id, 2, 'priority 0 is a real priority (not 50)');
}
{
  const r = resolveAndApply([
    entry(1, { benefitType: 'free_delivery' }),
    entry(2, { benefitType: 'delivery_discount', discountValue: 1 }),
    entry(3, { benefitType: 'percentage_discount', discountValue: 10 }),
  ], basket60);
  assert.deepStrictEqual(r.applied.map((a) => a.promotion.id).sort(), [1, 3], 'best delivery offer + basket promo');
}
{
  const r = resolveAndApply([
    entry(1, { benefitType: 'percentage_discount', discountValue: 10, stackGroup: 'welcome', stackable: true }),
    entry(2, { benefitType: 'fixed_amount_discount', discountValue: 5, stackGroup: 'welcome', stackable: true }),
  ], basket60);
  assert.strictEqual(r.applied.length, 1, 'same stack group: only one');
}

// Invariants on random combinations (master plan §121)
const TYPES = [
  () => ({ benefitType: 'percentage_discount', discountValue: 1 + Math.floor(Math.random() * 100) }),
  () => ({ benefitType: 'fixed_amount_discount', discountValue: Math.floor(Math.random() * 80) + 1 }),
  () => ({ benefitType: 'basket_discount', discountMode: Math.random() < 0.5 ? 'amount' : 'percent', discountValue: 1 + Math.floor(Math.random() * 90) }),
  () => ({ benefitType: 'category_discount', discountValue: 1 + Math.floor(Math.random() * 100), targetIds: [10, 11] }),
  () => ({ benefitType: 'item_discount', discountMode: 'amount', discountValue: Math.random() * 30, targetType: 'all' }),
  () => ({ benefitType: 'service_discount', discountValue: 1 + Math.floor(Math.random() * 100), targetIds: [100], maxDiscountCap: Math.random() * 20 }),
  () => ({ benefitType: 'fixed_price', discountValue: Math.random() * 70 }),
  () => ({ benefitType: 'free_delivery' }),
  () => ({ benefitType: 'delivery_discount', discountValue: Math.random() * 6 }),
  () => ({ benefitType: 'cashback', discountValue: 1 + Math.floor(Math.random() * 100) }),
];
for (let run = 0; run < 3000; run++) {
  const n = 1 + Math.floor(Math.random() * 6);
  const promos = Array.from({ length: n }, (_, i) => entry(i + 1, {
    ...TYPES[Math.floor(Math.random() * TYPES.length)](),
    stackable: Math.random() < 0.5,
    priority: Math.floor(Math.random() * 100),
  }));
  const r = resolveAndApply(promos, basket60);
  const lineSum = r.applied.flatMap((a) => a.benefit.adjustments).filter((a) => a.lineType !== 'delivery').reduce((s, a) => s - a.amountMinor, 0);
  const delivery = r.applied.flatMap((a) => a.benefit.adjustments).filter((a) => a.lineType === 'delivery').reduce((s, a) => s - a.amountMinor, 0);
  assert.ok(r.totalSavingMinor >= 0, 'discount >= 0');
  assert.ok(lineSum <= 6000, `order discount ${lineSum} ≤ subtotal`);
  assert.ok(delivery <= 300, 'delivery discount ≤ delivery fee');
  assert.strictEqual(lineSum + delivery, r.totalSavingMinor, 'sum(line discounts) == total discount');
  r.state.lines.forEach((l) => assert.ok(l.balanceMinor >= 0, 'line balance never negative'));
  assert.strictEqual(r.applied.length + r.rejected.length, n, 'every promotion is either applied or explained');
}

{
  const promos = [
    { id: 1, stackGroup: 'welcome', zoneScopeMode: 'all', zoneIds: [], startDate: null, endDate: null, benefitType: 'percentage_discount', stackable: false },
    { id: 2, stackGroup: 'welcome', zoneScopeMode: 'all', zoneIds: [], startDate: null, endDate: null, benefitType: 'fixed_amount_discount', stackable: false },
    { id: 3, zoneScopeMode: 'selected', zoneIds: [9], startDate: null, endDate: null, benefitType: 'percentage_discount', stackable: false },
  ];
  const conflicts = detectConflicts(promos);
  assert.ok(conflicts.some((c) => c.a.id === 1 && c.b.id === 2), 'same stack group detected');
}

console.log('✅ Stacking resolver: all passed');
console.log('\n🎉 All enterprise promotion engine tests passed!');

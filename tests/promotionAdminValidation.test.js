'use strict';

/**
 * Promotion admin payload normalisation + validation (no DB queries).
 * Run: node tests/promotionAdminValidation.test.js
 */

const assert = require('assert');

// Isolate from live Sequelize / gitignored config.json (CI has no config.json).
require('./stubSequelizeModels').install();

const {
  normalizePayload, validatePromotion, TRANSITIONS, restrictedZoneOf, typeRuleFields, assertNoOrderHistoryCondition,
} = require('../services/Admin/promotionAdminService');

const base = {
  name: 'Test', benefitType: 'percentage_discount', discountValue: 10, zoneScopeMode: 'all',
  activationType: 'automatic', visibility: 'public', repricingPolicy: 'recalculate', priority: 50, perCustomerLimit: 1,
};
const ok = (p) => assert.doesNotThrow(() => validatePromotion(p));
const bad = (p, re) => assert.throws(() => validatePromotion(p), re);

// Normalisation: "" → null, numbers parsed, codes upper-cased, perCustomerLimit null kept
{
  const n = normalizePayload({
    name: '  Summer  ', startDate: '', endDate: '', discountValue: '12.5', priority: 0, perCustomerLimit: null,
    recurringStartTime: '09:00:00', couponCodes: [{ code: ' summer20 ' }], unknownField: 'x',
  });
  assert.strictEqual(n.name, 'Summer');
  assert.strictEqual(n.startDate, null);
  assert.strictEqual(n.endDate, null);
  assert.strictEqual(n.discountValue, 12.5);
  assert.strictEqual(n.priority, 0, 'priority 0 stays 0');
  assert.strictEqual(n.perCustomerLimit, null, 'null = unlimited, not 1');
  assert.strictEqual(n.recurringStartTime, '09:00');
  assert.deepStrictEqual(n.couponCodes, [{ code: 'SUMMER20' }], 'only sent coupon fields are kept');
  assert.ok(!('unknownField' in n));
}

ok(base);
bad({ ...base, benefitType: 'buy_x_get_y' }, /not supported/);
bad({ ...base, discountValue: 150 }, /exceed 100/);
bad({ ...base, benefitType: 'category_discount', discountValue: 150, targetIds: [1] }, /exceed 100/);
ok({ ...base, benefitType: 'basket_discount', discountMode: 'amount', discountValue: 150 });
bad({ ...base, discountValue: null }, /required/);
ok({ ...base, benefitType: 'free_delivery', discountValue: null });
bad({ ...base, benefitType: 'category_discount', targetIds: [] }, /target/);
bad({ ...base, benefitType: 'item_discount', targetType: 'basket', targetIds: [1] }, /target type/);
ok({ ...base, benefitType: 'item_discount', targetType: 'all', targetIds: null });
bad({ ...base, benefitType: 'first_x_orders_discount' }, /firstOrders/);
ok({ ...base, benefitType: 'first_x_orders_discount', benefitConfig: { firstOrders: 3 } });
bad({ ...base, zoneScopeMode: 'selected', zoneIds: [] }, /zone/);
bad({ ...base, startDate: '2026-12-31', endDate: '2026-01-01' }, /End date/);
bad({ ...base, recurringStartTime: '09:00', recurringEndTime: null }, /both/);
bad({ ...base, minSubtotal: 50, maxSubtotal: 20 }, /Minimum subtotal/);
bad({ ...base, perCustomerLimit: 0 }, /perCustomerLimit/);
bad({ ...base, conditions: [{ conditionType: 'PAYMENT_METHOD', operator: 'equals', value: true }] }, /PAYMENT_METHOD/);
bad({ ...base, couponCodes: [{ code: 'DUP1' }, { code: 'DUP1' }] }, /twice/);
bad({ ...base, couponCodes: [{ code: 'A' }] }, /3–50/);
bad({ ...base, activationType: 'coupon_required', couponCodes: [] }, /at least one coupon/);
bad({ ...base, couponCodes: [{ code: 'VIP123', codeType: 'customer_bound' }] }, /no customer/);
bad({ ...base, zoneOverrides: [{ zoneId: 1 }, { zoneId: 1 }] }, /one override/);

// Dates: a calendar day is the whole UK day, a full timestamp is kept
{
  const n = normalizePayload({ startDate: '2026-10-13', endDate: '2026-10-15' });
  assert.strictEqual(n.startDate.toISOString(), '2026-10-12T23:00:00.000Z');
  assert.strictEqual(n.endDate.toISOString(), '2026-10-15T22:59:59.000Z');
  assert.strictEqual(normalizePayload({ startDate: '2026-10-12T19:00:00.000Z' }).startDate, '2026-10-12T19:00:00.000Z');
  ok({ ...base, ...normalizePayload({ startDate: '2026-10-13', endDate: '2026-10-13' }) });
}

// The type decides these limits, whatever was sent
assert.deepStrictEqual(typeRuleFields({ benefitType: 'first_order_discount', perCustomerLimit: 5, perDayLimit: 20 }), { perCustomerLimit: 1, perDayLimit: null, perWeekLimit: null });
assert.deepStrictEqual(typeRuleFields({ benefitType: 'first_x_orders_discount', benefitConfig: { firstOrders: 3 }, perCustomerLimit: 1 }), { perCustomerLimit: 3 });
assert.deepStrictEqual(typeRuleFields({ benefitType: 'first_x_orders_discount', benefitConfig: null }), {}, 'a missing N is left for validation');
assert.deepStrictEqual(typeRuleFields({ benefitType: 'basket_discount', perCustomerLimit: 5 }), {}, 'other types keep what the admin chose');

// A first-order type does not take an order-history condition as well
assert.throws(() => assertNoOrderHistoryCondition('first_order_discount', [{ conditionType: 'FIRST_ORDER' }]), /first order\. Remove the "First order" condition/);
assert.throws(() => assertNoOrderHistoryCondition('first_x_orders_discount', [{ conditionType: 'PAYMENT_METHOD' }, { conditionType: 'ORDER_COUNT' }]), /Previous order count/);
assert.doesNotThrow(() => assertNoOrderHistoryCondition('first_order_discount', [{ conditionType: 'PAYMENT_METHOD' }]));
assert.doesNotThrow(() => assertNoOrderHistoryCondition('basket_discount', [{ conditionType: 'FIRST_ORDER' }]), 'other types may target by order history');
assert.doesNotThrow(() => assertNoOrderHistoryCondition('first_order_discount', null));

// Lifecycle: active/scheduled only reachable through publish
assert.ok(!Object.values(TRANSITIONS).some((targets) => targets.includes('active') || targets.includes('scheduled')));

// Zone scope
assert.strictEqual(restrictedZoneOf({ isPlatformAdmin: true }), null);
assert.strictEqual(restrictedZoneOf({ isPlatformAdmin: false, roleScope: 'platform' }), null);
assert.strictEqual(restrictedZoneOf({ isPlatformAdmin: false, roleScope: 'zone', zoneId: 3 }), 3);
assert.throws(() => restrictedZoneOf({ isPlatformAdmin: false, roleScope: 'zone', zoneId: null }), /no zone/);

console.log('✅ Promotion admin validation: all passed');
process.exit(0);

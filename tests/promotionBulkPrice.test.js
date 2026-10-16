'use strict';
/**
 * Bulk price (benefitType "bundle"): "10 shirts for £25". Every full group of the
 * chosen items costs the group price; pieces left over pay the normal price.
 * Pure (models stubbed), so it runs in CI.
 */
const assert = require('assert');

require('./stubSequelizeModels').install();

const {
  computeBenefit, applyBenefit, createPricingState, limitBasket, bundleQuantity,
} = require('../services/promotions/benefitHandlers');
const { builtInCheck, buildOfferLabel } = require('../services/promotions/promotionEngine');
const { normalizePayload, validatePromotion } = require('../services/Admin/promotionAdminService');

const SHIRT = 21;
const SHIRT_HANGER = 22;
const TROUSERS = 23;

const line = (subCategoryId, price, qty) => ({
  serviceId: 2, categoryId: 5, subCategoryId, addonId: null, price, qty,
});
const contextOf = (lineItems) => ({
  basket: {
    lineItems,
    subtotal: lineItems.reduce((s, li) => s + li.price * li.qty, 0),
    itemCount: lineItems.reduce((s, li) => s + li.qty, 0),
  },
});

const bulk = (extra = {}) => ({
  id: 1, benefitType: 'bundle', targetType: 'subCategory', targetIds: [SHIRT],
  discountValue: 25, benefitConfig: { bundleQuantity: 10 }, currency: 'GBP', ...extra,
});

const run = (promo, lineItems) => {
  const state = createPricingState(contextOf(lineItems));
  const benefit = computeBenefit(promo, state);
  benefit.lineMinor.forEach((v, i) => {
    assert.ok(v >= 0 && v <= state.lines[i].balanceMinor, 'a line never goes below £0');
  });
  assert.strictEqual(benefit.lineMinor.reduce((s, v) => s + v, 0), benefit.totalSavingMinor, 'line discounts add up');
  return benefit;
};

// 10 shirts at £2.90 = £29 → £25, so £4 off.
{
  const b = run(bulk(), [line(SHIRT, 2.9, 10)]);
  assert.strictEqual(b.totalSavingMinor, 400);
  assert.strictEqual(b.label, '10 for £25.00');
  assert.strictEqual(b.description, 'Bulk price');
}

// 12 shirts: one group of 10 for £25, the other 2 pay £2.90 each (£30.80 in all).
assert.strictEqual(run(bulk(), [line(SHIRT, 2.9, 12)]).totalSavingMinor, 400);

// 20 shirts: two groups.
assert.strictEqual(run(bulk(), [line(SHIRT, 2.9, 20)]).totalSavingMinor, 800);

// 9 shirts: no full group, no discount.
assert.strictEqual(run(bulk(), [line(SHIRT, 2.9, 9)]).totalSavingMinor, 0);

// Other items are not touched and do not count towards the group.
{
  const b = run(bulk(), [line(SHIRT, 2.9, 10), line(TROUSERS, 6, 3)]);
  assert.deepStrictEqual(b.lineMinor, [400, 0]);
  assert.strictEqual(run(bulk(), [line(SHIRT, 2.9, 7), line(TROUSERS, 6, 3)]).totalSavingMinor, 0);
}

// Two chosen items count together; the cheapest pieces are grouped first.
// 6 × £2.90 + 5 × £3.50 = 11 pieces → group = 6 × £2.90 + 4 × £3.50 = £31.40 → £6.40 off;
// the 11th piece (£3.50) pays the normal price.
{
  const promo = bulk({ targetIds: [SHIRT, SHIRT_HANGER] });
  const b = run(promo, [line(SHIRT_HANGER, 3.5, 5), line(SHIRT, 2.9, 6)]);
  assert.strictEqual(b.totalSavingMinor, 640);
  const [hanger, folded] = b.lineMinor;
  assert.ok(hanger < 4 * 350 && folded < 6 * 290);
}

// A group is never made dearer than its normal price (10 × £2 = £20 < £25).
assert.strictEqual(run(bulk(), [line(SHIRT, 2, 10)]).totalSavingMinor, 0);

// Max discount cap still limits the whole promotion.
assert.strictEqual(run(bulk({ maxDiscountCap: 5 }), [line(SHIRT, 2.9, 20)]).totalSavingMinor, 500);

// Prices that do not split evenly into pence still add up exactly.
{
  const b = run(bulk({ discountValue: 10, benefitConfig: { bundleQuantity: 3 } }), [line(SHIRT, 3.33, 4)]);
  assert.strictEqual(b.totalSavingMinor, 0, '3 × £3.33 = £9.99 is already below £10');
  const b2 = run(bulk({ discountValue: 7, benefitConfig: { bundleQuantity: 3 } }), [line(SHIRT, 3.33, 4)]);
  assert.strictEqual(b2.totalSavingMinor, 999 - 700);
}

// A non-stackable item promotion already on the shirts keeps them to itself.
{
  const state = createPricingState(contextOf([line(SHIRT, 2.9, 10)]));
  const first = { id: 9, benefitType: 'item_discount', targetType: 'subCategory', targetIds: [SHIRT], discountMode: 'percent', discountValue: 10 };
  applyBenefit(first, state, computeBenefit(first, state));
  assert.strictEqual(computeBenefit(bulk(), state).totalSavingMinor, 0);
}

// Group size stored as JSON text (MariaDB) is read the same.
assert.strictEqual(bundleQuantity({ benefitConfig: '{"bundleQuantity":10}' }), 10);
assert.strictEqual(bundleQuantity({ benefitConfig: { bundleQuantity: 1 } }), 0, 'a group needs at least 2 pieces');
assert.strictEqual(run(bulk({ benefitConfig: '{"bundleQuantity":10}' }), [line(SHIRT, 2.9, 10)]).totalSavingMinor, 400);

// Spend / quantity limits count only the chosen items.
assert.deepStrictEqual(
  limitBasket(bulk(), contextOf([line(SHIRT, 2.9, 10), line(TROUSERS, 6, 3)])),
  { subtotal: 29, itemCount: 10, offerItemsOnly: true }
);

// Too few pieces at invoice: tell the shop / customer how many more.
{
  const usage = new Map();
  const short = builtInCheck(bulk(), contextOf([line(SHIRT, 2.9, 7), line(TROUSERS, 6, 3)]), null, usage);
  assert.strictEqual(short.reason, 'Add 3 more items from this offer to get 10 for £25.00');
  assert.strictEqual(builtInCheck(bulk(), contextOf([line(SHIRT, 2.9, 9)]), null, usage).reason,
    'Add 1 more item from this offer to get 10 for £25.00');
  assert.strictEqual(builtInCheck(bulk(), contextOf([line(SHIRT, 2.9, 10)]), null, usage), null);
  // At booking the items are not known yet, so the offer is not turned away.
  assert.strictEqual(builtInCheck(bulk(), { basket: { subtotal: 0, itemCount: 0 } }, null, usage), null);
}

// Customer offer label.
assert.strictEqual(buildOfferLabel(bulk()), '10 for £25.00 on selected items');
assert.strictEqual(buildOfferLabel(bulk({ maxDiscountCap: 5 })), '10 for £25.00 on selected items (up to £5.00 off in total)');

// Admin: saving a Bulk price promotion.
{
  const base = {
    name: 'Shirts 10 for £25', zoneScopeMode: 'all', activationType: 'automatic', visibility: 'public',
    repricingPolicy: 'recalculate', priority: 50, perCustomerLimit: null,
  };
  const payload = normalizePayload({
    ...base, benefitType: 'bundle', discountValue: '25', targetType: 'subCategory', targetIds: [SHIRT],
    benefitConfig: { bundleQuantity: '10' },
  });
  assert.deepStrictEqual(payload.benefitConfig, { bundleQuantity: 10 });
  assert.doesNotThrow(() => validatePromotion(payload));
  assert.throws(() => validatePromotion({ ...payload, benefitConfig: null }), /how many pieces/);
  assert.throws(() => validatePromotion({ ...payload, benefitConfig: { bundleQuantity: 1 } }), /how many pieces/);
  assert.throws(() => validatePromotion({ ...payload, benefitConfig: { bundleQuantity: 2.5 } }), /how many pieces/);
  assert.throws(() => validatePromotion({ ...payload, targetType: 'basket' }), /Bulk price needs a target type/);
  assert.throws(() => validatePromotion({ ...payload, targetIds: [] }), /Choose at least one target/);
  assert.throws(() => validatePromotion({ ...payload, discountValue: 0 }), /greater than 0/);
  assert.doesNotThrow(() => validatePromotion({ ...payload, discountValue: 150 }), 'a group price is £, not %');
}

console.log('promotionBulkPrice.test.js passed');

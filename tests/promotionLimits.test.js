'use strict';
/**
 * Spend / quantity limits: item, category and service discounts measure only the
 * items they target; basket-wide offers measure the whole basket.
 * Pure (no models), so it runs in CI.
 */
const assert = require('assert');
const { limitBasket } = require('../services/promotions/benefitHandlers');

const WASH_IRON = 11;
const DRY_CLEAN = 12;
const ALTERATION = 1;

const line = (serviceId, price, qty, extra = {}) => ({
  serviceId, categoryId: null, subCategoryId: 100 + serviceId, addonId: null, price, qty, ...extra,
});

// Wash & Iron + Dry Clean come to £95; Alteration adds £55 (whole laundry £150).
const lines = [line(WASH_IRON, 5, 5), line(DRY_CLEAN, 10, 7), line(ALTERATION, 27.5, 2)];
const context = {
  basket: { subtotal: 150, itemCount: 14, lineItems: lines },
};

const serviceDiscount = { benefitType: 'service_discount', targetIds: [WASH_IRON, DRY_CLEAN] };
const fromService = limitBasket(serviceDiscount, context);
assert.deepStrictEqual(fromService, { subtotal: 95, itemCount: 12, offerItemsOnly: true },
  'service discount measures only Wash & Iron and Dry Clean');

const basketDiscount = { benefitType: 'basket_discount' };
assert.deepStrictEqual(limitBasket(basketDiscount, context), { subtotal: 150, itemCount: 14, offerItemsOnly: false },
  'basket discount measures the whole laundry, Alteration included');

const categoryDiscount = { benefitType: 'category_discount', targetIds: [77] };
assert.deepStrictEqual(limitBasket(categoryDiscount, context), { subtotal: 0, itemCount: 0, offerItemsOnly: true },
  'no matching items: nothing counts towards the limits');

const itemDiscount = { benefitType: 'item_discount', targetType: 'subCategory', targetIds: [100 + DRY_CLEAN] };
assert.deepStrictEqual(limitBasket(itemDiscount, context), { subtotal: 70, itemCount: 7, offerItemsOnly: true },
  'item discount measures only the chosen item');

assert.deepStrictEqual(limitBasket(basketDiscount, {}), { subtotal: 0, itemCount: 0, offerItemsOnly: false },
  'missing basket is treated as empty');

console.log('promotionLimits.test.js passed');

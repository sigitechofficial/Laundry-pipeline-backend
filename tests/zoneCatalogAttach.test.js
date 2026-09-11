"use strict";

const assert = require("assert");
const {
  effectiveAttach,
  attachKey,
  money,
  parseEnabled,
  enabledOf,
  mergeOverridePatch,
  effectiveDisplayPrice,
} = require("../utils/zoneCatalogRules");

assert.strictEqual(attachKey(12, 4), "12:4");
assert.strictEqual(money("2.955"), 2.96);
assert.strictEqual(money("x"), 0);

assert.strictEqual(effectiveAttach(true, null, true), true);
assert.strictEqual(effectiveAttach(false, null, true), false);
assert.strictEqual(effectiveAttach(false, { isEnabled: true }, true), false);
assert.strictEqual(effectiveAttach(true, { isEnabled: false }, true), false);
assert.strictEqual(effectiveAttach(true, { isEnabled: true }, true), true);
assert.strictEqual(effectiveAttach(true, { isEnabled: true }, false), false);
assert.strictEqual(effectiveAttach(true, null, false), false);

assert.strictEqual(parseEnabled(false), false);
assert.strictEqual(parseEnabled("false"), false);
assert.strictEqual(parseEnabled(0), false);
assert.strictEqual(parseEnabled(true), true);
assert.strictEqual(enabledOf(undefined), true);
assert.strictEqual(enabledOf({ isEnabled: false }), false);
assert.strictEqual(enabledOf({ isEnabled: true }), true);

const createPriceOnly = mergeOverridePatch({ price: "9.50" }, { hasPrice: true, creating: true });
assert.strictEqual(createPriceOnly.isEnabled, true);
assert.strictEqual(createPriceOnly.price, 9.5);

const hideOnly = mergeOverridePatch({ isEnabled: false }, { hasPrice: true, creating: false });
assert.deepStrictEqual(Object.keys(hideOnly).sort(), ["isEnabled"]);
assert.strictEqual(hideOnly.isEnabled, false);

const priceAfterHide = mergeOverridePatch(
  { price: 12 },
  { hasPrice: true, creating: false }
);
assert.strictEqual(priceAfterHide.price, 12);
assert.strictEqual(priceAfterHide.isEnabled, undefined);

const live = effectiveDisplayPrice(10, 15, true);
assert.deepStrictEqual(live, { price: 15, inherited: false, staged: false });
const staged = effectiveDisplayPrice(10, 15, false);
assert.deepStrictEqual(staged, { price: 10, inherited: false, staged: true });
const inherit = effectiveDisplayPrice(10, null, true);
assert.deepStrictEqual(inherit, { price: 10, inherited: true, staged: false });

console.log("zoneCatalogAttach tests passed");

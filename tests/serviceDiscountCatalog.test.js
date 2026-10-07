'use strict';

/**
 * Lightweight unit tests for service-discount catalog decoration (no DB).
 * Run: node tests/serviceDiscountCatalog.test.js
 */

const assert = require('assert');
const path = require('path');

// Load only the pure helpers by requiring the module after stubbing models
// is heavy — instead re-implement the matching contract against exported fns
// once models are mockable. Here we test the exported sync pickers by
// temporarily requiring after patching require cache for models.

const Module = require('module');
const originalLoad = Module._load;

const fakeModels = {
  serviceDiscount: { findAll: async () => [] },
  subCategories: {},
  addOnServices: {},
  categories: {},
};

Module._load = function (request, parent, isMain) {
  if (
    request === '../../models' ||
    request.endsWith(`${path.sep}models`) ||
    request.endsWith('/models') ||
    request === path.join(__dirname, '..', 'models')
  ) {
    // Controllers/services resolve models via relative paths — intercept common ones
  }
  if (
    typeof request === 'string' &&
    (request === '../../models' ||
      request === '../models' ||
      request.endsWith('/models/index') ||
      request.endsWith('\\models\\index') ||
      request === path.resolve(__dirname, '../models'))
  ) {
    return fakeModels;
  }
  return originalLoad.apply(this, arguments);
};

// Also stub universalErrorHandler if needed through normal load
let svc;
try {
  // Clear cache for service file
  const svcPath = require.resolve('../services/Admin/serviceDiscountService');
  delete require.cache[svcPath];
  svc = require('../services/Admin/serviceDiscountService');
} finally {
  Module._load = originalLoad;
}

assert.ok(svc.pickBestDiscountFromRules, 'pickBestDiscountFromRules exported');
assert.ok(svc.decoratePriceWithDiscount, 'decoratePriceWithDiscount exported');
assert.ok(svc.normalizeTargetIds, 'normalizeTargetIds exported');

// ── normalizeTargetIds ───────────────────────────────────────────────────────
assert.deepStrictEqual(
  svc.normalizeTargetIds({ targetType: 'all', targetIds: [1, 2] }),
  []
);
assert.deepStrictEqual(
  svc.normalizeTargetIds({ targetType: 'service', targetIds: [1, 2, 2, '3'] }),
  [1, 2, 3]
);
assert.deepStrictEqual(
  svc.normalizeTargetIds({ targetType: 'addon', targetId: 9 }),
  [9]
);
assert.deepStrictEqual(
  svc.normalizeTargetIds({ targetType: 'category', targetIds: [] }),
  []
);

// ── pickBestDiscountFromRules ────────────────────────────────────────────────
const rules = [
  {
    id: 1,
    name: 'Wash 20%',
    discountType: 'percentage',
    discountValue: 20,
    maxDiscountCap: null,
    targetType: 'service',
    targetId: 10,
    targetIds: [10, 11],
    zoneMode: 'all',
    zoneIds: null,
  },
  {
    id: 2,
    name: 'Shirt £3 off',
    discountType: 'flat',
    discountValue: 3,
    maxDiscountCap: null,
    targetType: 'subCategory',
    targetId: 55,
    targetIds: [55],
    zoneMode: 'specific',
    zoneIds: [7],
  },
  {
    id: 3,
    name: 'Addon 50%',
    discountType: 'percentage',
    discountValue: 50,
    maxDiscountCap: 2,
    targetType: 'addon',
    targetIds: [100],
    zoneMode: 'all',
    zoneIds: null,
  },
];

// Service-only match → 20% of £10 = £2
{
  const r = svc.pickBestDiscountFromRules(
    rules,
    7,
    { serviceId: 10, categoryId: 1, subCategoryId: 999 },
    10
  );
  assert.strictEqual(r.discountedPrice, '8.00');
  assert.strictEqual(r.originalPrice, '10.00');
  assert.strictEqual(r.saving, '2.00');
  assert.ok(r.appliedDiscount);
  assert.strictEqual(r.appliedDiscount.label, '20% OFF');
}

// Flat £3 on item 55 in zone 7 beats service 20% (£2) → best is £3
{
  const r = svc.pickBestDiscountFromRules(
    rules,
    7,
    { serviceId: 10, categoryId: 1, subCategoryId: 55 },
    10
  );
  assert.strictEqual(r.saving, '3.00');
  assert.strictEqual(r.discountedPrice, '7.00');
  assert.strictEqual(r.appliedDiscount.name, 'Shirt £3 off');
}

// Zone-specific rule skipped when zone mismatches
{
  const r = svc.pickBestDiscountFromRules(
    rules,
    99,
    { serviceId: 99, subCategoryId: 55 },
    10
  );
  assert.strictEqual(r.appliedDiscount, null);
  assert.strictEqual(r.discountedPrice, '10.00');
}

// Addon with cap: 50% of £10 = £5, capped at £2
{
  const r = svc.pickBestDiscountFromRules(
    rules,
    null,
    { addOnServiceId: 100 },
    10
  );
  assert.strictEqual(r.saving, '2.00');
  assert.strictEqual(r.discountedPrice, '8.00');
  assert.strictEqual(r.appliedDiscount.label, '50% OFF');
}

// Multi-target: service 11 also matches
{
  const r = svc.pickBestDiscountFromRules(
    rules,
    1,
    { serviceId: 11, subCategoryId: 1 },
    20
  );
  assert.strictEqual(r.saving, '4.00');
  assert.strictEqual(r.discountedPrice, '16.00');
}

// decoratePriceWithDiscount
{
  const row = svc.decoratePriceWithDiscount(
    { id: 100, name: 'Hem', price: '10.00' },
    rules,
    1,
    { addOnServiceId: 100 }
  );
  assert.strictEqual(row.hasDiscount, true);
  assert.strictEqual(row.price, '8.00');
  assert.strictEqual(row.originalPrice, '10.00');
  assert.ok(row.appliedDiscount);
}

{
  const row = svc.decoratePriceWithDiscount(
    { id: 1, name: 'Plain', price: '5.00' },
    rules,
    1,
    { subCategoryId: 999 }
  );
  assert.strictEqual(row.hasDiscount, false);
  assert.strictEqual(row.price, '5.00');
  assert.strictEqual(row.originalPrice, null);
}

console.log('OK — serviceDiscountCatalog.test.js passed (%d assertions)', 20);
process.exit(0);

'use strict';

const assert = require('assert');
const {
  looksLikeCustomerIntentRow,
  pickCustomerIntentCloneSource,
} = require('../utils/recurringCloneIntent');

assert.strictEqual(looksLikeCustomerIntentRow({ serviceId: 1, subCategoryId: null }), true);
assert.strictEqual(looksLikeCustomerIntentRow({ serviceId: 1, subCategoryId: 44 }), false);

const snapshot = pickCustomerIntentCloneSource({
  snapshotRows: [{ id: 10, serviceId: 3, items: 2, bags: 1 }],
  cssRows: [{ id: 99, serviceId: 3, subCategoryId: 12, items: 8 }],
});
assert.strictEqual(snapshot.source, 'snapshot');
assert.strictEqual(snapshot.rows[0].id, 10);

const cssIntent = pickCustomerIntentCloneSource({
  snapshotRows: [],
  cssRows: [
    { id: 1, serviceId: 7, subCategoryId: null, items: 4 },
    { id: 2, serviceId: 7, subCategoryId: 9, items: 12 },
  ],
});
assert.strictEqual(cssIntent.source, 'css_intent');
assert.strictEqual(cssIntent.rows.length, 1);
assert.strictEqual(cssIntent.rows[0].id, 1);

const none = pickCustomerIntentCloneSource({
  snapshotRows: [],
  cssRows: [{ id: 5, serviceId: 8, subCategoryId: 22, items: 3 }],
});
assert.strictEqual(none.source, 'none');
assert.strictEqual(none.rows.length, 0);

console.log('recurringCloneIntent.test.js ok');

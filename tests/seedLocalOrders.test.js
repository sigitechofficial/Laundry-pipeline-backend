'use strict';

const assert = require('assert/strict');
const { readInput, historyFor, ORDERS, CUSTOMERS } = require('../scripts/seed-local-orders');

// Guards: development only; flags parsed.
assert.throws(() => readInput({ NODE_ENV: 'production' }, []), /NODE_ENV must be exactly "development"/);
assert.throws(() => readInput({}, []), /development/);
assert.deepEqual(readInput({ NODE_ENV: 'development' }, []), { reset: false, removeOnly: false });
assert.deepEqual(readInput({ NODE_ENV: 'development' }, ['--reset']), { reset: true, removeOnly: false });
assert.deepEqual(readInput({ NODE_ENV: 'development' }, ['--remove']), { reset: false, removeOnly: true });

// Histories walk the real lifecycle and end at the order's status.
assert.deepEqual(historyFor(1), [1]);
assert.deepEqual(historyFor(8), [1, 2, 3, 4, 5, 6, 7, 8]);
assert.deepEqual(historyFor(17), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17]);
assert.deepEqual(historyFor(19), [1, 2, 3, 19]);
assert.deepEqual(historyFor(18).slice(-2), [9, 18]);
assert.deepEqual(historyFor(15).slice(-2), [14, 15]);
for (const o of ORDERS) assert.equal(historyFor(o.status).at(-1), o.status);

// The spread covers every stage the shop app shows, with both payment types.
const statuses = new Set(ORDERS.map((o) => o.status));
for (const s of [1, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 17, 18, 19]) assert.ok(statuses.has(s), `status ${s} seeded`);
assert.ok(ORDERS.some((o) => o.pay === 'cash') && ORDERS.some((o) => o.pay === 'card'));

// Realistic: pickups inside shop opening hours (09:00-18:00), invoiced stages priced.
for (const o of ORDERS) {
  assert.ok(o.slot >= 9 && o.slot + 1 <= 18, `slot ${o.slot} inside opening hours`);
  assert.ok(CUSTOMERS[o.c], 'customer exists');
  if (o.status >= 10 && o.status !== 19) assert.ok(o.lines?.length, `status ${o.status} has invoice lines`);
  if (o.status < 9) assert.equal(o.lines, undefined, `status ${o.status} not invoiced yet`);
}
for (const c of CUSTOMERS) assert.match(c.email, /^seed\.[a-z]+@justdrycleans\.test$/);

console.log('seedLocalOrders.test.js: all assertions passed');

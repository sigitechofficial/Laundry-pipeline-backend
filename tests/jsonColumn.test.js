'use strict';

/**
 * JSON columns read the same on MySQL (parsed value) and MariaDB (text).
 * No database needed.   node tests/jsonColumn.test.js
 */

const assert = require('assert');
const { jsonColumn, parseJsonValue } = require('../utils/jsonColumn');

// MariaDB: text in, parsed value out
assert.deepStrictEqual(parseJsonValue('[25]'), [25]);
assert.deepStrictEqual(parseJsonValue(' {"firstOrders":3}'), { firstOrders: 3 });
assert.strictEqual(parseJsonValue('"card"'), 'card');
assert.deepStrictEqual(parseJsonValue('"[1,2]"'), [1, 2], 'double-encoded list');
// MySQL: already parsed, left alone
assert.deepStrictEqual(parseJsonValue([25]), [25]);
assert.strictEqual(parseJsonValue('card'), 'card');
assert.strictEqual(parseJsonValue('5'), '5', 'plain text is not turned into a number');
assert.strictEqual(parseJsonValue(null), null);
assert.strictEqual(parseJsonValue('[broken'), '[broken', 'bad JSON is returned as it is');

// The attribute getter reads through getDataValue, like a Sequelize instance
const attr = jsonColumn({ JSON: 'JSON' }, 'zoneIds', { allowNull: true });
assert.strictEqual(attr.type, 'JSON');
assert.strictEqual(attr.allowNull, true);
assert.deepStrictEqual(attr.get.call({ getDataValue: (name) => (name === 'zoneIds' ? '[3,7]' : undefined) }), [3, 7]);

// The engine's zone check, with the row as each database returns it
const { zoneInScope } = (() => {
  const Module = require('module');
  const load = Module._load;
  Module._load = function patched(request, ...rest) {
    if (/models$/.test(request)) return {};
    return load.call(this, request, ...rest);
  };
  try {
    return require('../services/promotions/promotionEngine');
  } finally {
    Module._load = load;
  }
})();
const row = (stored) => ({ zoneScopeMode: 'selected', zoneIds: attr.get.call({ getDataValue: () => stored }) });
assert.strictEqual(zoneInScope(row('[25]'), 25), true, 'MariaDB text: zone 25 is in a promotion for zone 25');
assert.strictEqual(zoneInScope(row([25]), 25), true, 'MySQL list');
assert.strictEqual(zoneInScope(row('[25]'), 3), false, 'other zone stays out');
assert.strictEqual(zoneInScope({ zoneScopeMode: 'selected', zoneIds: '[25]' }, 25), false, 'unparsed text is the failure this fixes');

console.log('jsonColumn.test.js passed');

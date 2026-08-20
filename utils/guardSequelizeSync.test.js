'use strict';

const assert = require('assert/strict');
const {
  assertSafeSyncOptions,
  guardSequelizeSync,
  isProductionEnv,
} = require('./guardSequelizeSync');

assert.equal(isProductionEnv('production'), true);
assert.equal(isProductionEnv('PRODUCTION'), true);
assert.equal(isProductionEnv('development'), false);
assert.equal(isProductionEnv('test'), false);

assert.doesNotThrow(() => assertSafeSyncOptions({ alter: true }, 'development'));
assert.doesNotThrow(() => assertSafeSyncOptions({ alter: true }, 'test'));
assert.doesNotThrow(() => assertSafeSyncOptions({}, 'production'));
assert.doesNotThrow(() => assertSafeSyncOptions(undefined, 'production'));

assert.throws(
  () => assertSafeSyncOptions({ alter: true }, 'production'),
  /forbidden in production/
);
assert.throws(
  () => assertSafeSyncOptions({ force: true }, 'production'),
  /forbidden in production/
);

const calls = [];
const fake = {
  sync(options) {
    calls.push(options);
    return Promise.resolve(options);
  },
};

guardSequelizeSync(fake, 'production');
assert.throws(() => fake.sync({ alter: true }), /forbidden in production/);
assert.equal(calls.length, 0);

guardSequelizeSync(
  {
    sync(options) {
      calls.push(options);
      return options;
    },
  },
  'development'
).sync({ alter: true });
assert.equal(calls.length, 1);

console.log('guardSequelizeSync tests passed');

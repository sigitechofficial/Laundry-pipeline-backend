'use strict';

const assert = require('assert');
const {
  parseZoneIds,
  isPolicyActiveForZone,
  percentsForStep,
  rampCommissionBase,
} = require('./revenueRamp');

const live = { agentCommissionPercent: 80, platformCommissionPercent: 20 };

assert.deepStrictEqual(parseZoneIds('[2, 2, 0, "4", "x"]'), [2, 4]);
assert.deepStrictEqual(parseZoneIds('3,3,9'), [3, 9]);
assert.deepStrictEqual(parseZoneIds(''), []);

assert.strictEqual(
  isPolicyActiveForZone({ enabled: false, applyToAllZones: true, zoneIds: [] }, 1),
  false
);
assert.strictEqual(
  isPolicyActiveForZone({ enabled: true, applyToAllZones: true, zoneIds: [] }, 8),
  true
);
assert.strictEqual(
  isPolicyActiveForZone({ enabled: true, applyToAllZones: false, zoneIds: [5] }, 5),
  true
);
assert.strictEqual(
  isPolicyActiveForZone({ enabled: true, applyToAllZones: false, zoneIds: [5] }, 6),
  false
);

assert.deepStrictEqual(percentsForStep(1, live), {
  agentCommissionPercent: 0,
  platformCommissionPercent: 100,
  revenueRampStep: 1,
});
assert.deepStrictEqual(percentsForStep(2, live), {
  agentCommissionPercent: 50,
  platformCommissionPercent: 50,
  revenueRampStep: 2,
});
assert.deepStrictEqual(percentsForStep(3, live), {
  agentCommissionPercent: 100,
  platformCommissionPercent: 0,
  revenueRampStep: 3,
});
assert.deepStrictEqual(percentsForStep(4, live), {
  agentCommissionPercent: 80,
  platformCommissionPercent: 20,
  revenueRampStep: 4,
});

assert.strictEqual(rampCommissionBase(40, 10, 1), 30);
assert.strictEqual(rampCommissionBase(40, 10, 2), 30);
assert.strictEqual(rampCommissionBase(40, 10, 3), 30);
assert.strictEqual(rampCommissionBase(40, 50, 3), 0);
assert.strictEqual(rampCommissionBase(40, 10, 4), 40);
assert.strictEqual(rampCommissionBase(40, 10, null), 40);

console.log('revenueRamp.test.js: all assertions passed');

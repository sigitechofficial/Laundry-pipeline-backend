'use strict';

const assert = require('assert/strict');
const {
    clampListLimit,
    clampPage,
    DEFAULT_LIST_LIMIT,
    DEFAULT_MAX_LIST_LIMIT,
    UNBOUNDED_LIST_SAFETY_MAX,
} = require('./listLimit');

assert.equal(DEFAULT_LIST_LIMIT, 20);
assert.equal(DEFAULT_MAX_LIST_LIMIT, 100);
assert.equal(UNBOUNDED_LIST_SAFETY_MAX, 500);

assert.equal(clampListLimit(undefined), DEFAULT_LIST_LIMIT);
assert.equal(clampListLimit(null), DEFAULT_LIST_LIMIT);
assert.equal(clampListLimit(''), DEFAULT_LIST_LIMIT);
assert.equal(clampListLimit('abc'), DEFAULT_LIST_LIMIT);
assert.equal(clampListLimit(0), DEFAULT_LIST_LIMIT);
assert.equal(clampListLimit(-5), DEFAULT_LIST_LIMIT);
assert.equal(clampListLimit(25), 25);
assert.equal(clampListLimit('25'), 25);
assert.equal(clampListLimit(100), 100);
assert.equal(clampListLimit(99999), DEFAULT_MAX_LIST_LIMIT);
assert.equal(clampListLimit('5000'), DEFAULT_MAX_LIST_LIMIT);

assert.equal(clampListLimit(50, 10, 30), 30);
assert.equal(clampListLimit(undefined, 25, 100), 25);
assert.equal(clampListLimit(12, 25, 100), 12);

assert.equal(clampPage(undefined), 1);
assert.equal(clampPage('3'), 3);
assert.equal(clampPage(0), 1);
assert.equal(clampPage(-2), 1);
assert.equal(clampPage('nope', 2), 2);

console.log('listLimit.test.js: all assertions passed');

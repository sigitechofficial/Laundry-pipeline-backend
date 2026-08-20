'use strict';

const assert = require('assert/strict');
const { assertNodeCompatible, nodeMajorFrom } = require('./ensureNodeCompat');

assert.equal(nodeMajorFrom('22.14.0'), 22);
assert.equal(nodeMajorFrom('20.19.0'), 20);

assert.deepEqual(assertNodeCompatible('22.14.0', 'production'), {
  ok: true,
  major: 22,
});
assert.equal(assertNodeCompatible('20.19.0', 'development').ok, false);
assert.equal(assertNodeCompatible('20.19.0', 'production').ok, false);

console.log('ensureNodeCompat tests passed');

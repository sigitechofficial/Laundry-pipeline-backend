'use strict';

const assert = require('assert');
const {
  ACCOUNT_BLOCKED_CODE,
  ACCOUNT_BLOCKED_MESSAGE,
  isUserBlocked,
  accountBlockedBody,
  looksLikeAccountBlockedPayload,
} = require('./accountBlocked');

assert.strictEqual(isUserBlocked(false), true);
assert.strictEqual(isUserBlocked(0), true);
assert.strictEqual(isUserBlocked('0'), true);
assert.strictEqual(isUserBlocked(true), false);
assert.strictEqual(isUserBlocked(1), false);

const body = accountBlockedBody();
assert.strictEqual(body.code, ACCOUNT_BLOCKED_CODE);
assert.strictEqual(body.message, ACCOUNT_BLOCKED_MESSAGE);
assert.strictEqual(looksLikeAccountBlockedPayload(body), true);
assert.strictEqual(
  looksLikeAccountBlockedPayload({ message: 'You are blocked from admin. Contact the support team.' }),
  true
);
assert.strictEqual(looksLikeAccountBlockedPayload({ message: 'Access Denied' }), false);

console.log('accountBlocked tests passed');

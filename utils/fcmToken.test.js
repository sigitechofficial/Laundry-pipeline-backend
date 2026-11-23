'use strict';

const assert = require('assert/strict');
const { isStaleTokenError } = require('./fcmToken');

// Dead tokens: delete.
assert.equal(isStaleTokenError({ code: 'messaging/registration-token-not-registered', message: 'Requested entity was not found.' }), true);
assert.equal(isStaleTokenError({ code: 'messaging/invalid-registration-token', message: 'Invalid registration token provided.' }), true);
assert.equal(
    isStaleTokenError({ code: 'messaging/invalid-argument', message: 'The registration token is not a valid FCM registration token' }),
    true
);

// Not the token's fault: keep (real FCM responses).
assert.equal(isStaleTokenError({ code: 'messaging/invalid-argument', message: 'Invalid APNs request.' }), false);
assert.equal(isStaleTokenError({ code: 'messaging/invalid-argument', message: 'Invalid value at message.data[0].value' }), false);
assert.equal(isStaleTokenError({ code: 'messaging/third-party-auth-error', message: 'Auth error from APNS or Web Push Service' }), false);
assert.equal(isStaleTokenError({ code: 'messaging/mismatched-credential', message: 'SenderId mismatch' }), false);
assert.equal(isStaleTokenError({ code: 'messaging/quota-exceeded', message: 'Quota exceeded' }), false);
assert.equal(isStaleTokenError({ code: 'messaging/internal-error', message: '' }), false);
assert.equal(isStaleTokenError({ code: 'unknown-error' }), false);
assert.equal(isStaleTokenError(null), false);

console.log('fcmToken.test.js: all assertions passed');

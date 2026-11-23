'use strict';

const assert = require('assert/strict');
const { customerLoginVerification } = require('./customerLoginVerification');

// Verified accounts sign in whether or not an OTP row exists (admin-created,
// provisioned or OTP-verified customers alike).
assert.deepEqual(customerLoginVerification({ verifiedAt: new Date() }, null), { verified: true });
assert.deepEqual(customerLoginVerification({ verifiedAt: '2026-01-01' }, { id: 4 }), { verified: true });

// Unverified with an OTP row: route to verification with that OTP id.
assert.deepEqual(customerLoginVerification({ verifiedAt: null }, { id: 9 }), { verified: false, otpId: 9 });

// Unverified with no OTP row: nothing to verify against.
assert.deepEqual(customerLoginVerification({ verifiedAt: null }, null), { verified: false, otpId: null });

console.log('customerLoginVerification.test.js: all assertions passed');

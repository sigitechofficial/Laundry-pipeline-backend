'use strict';

const assert = require('assert/strict');
const { redact, REDACTED } = require('./redact');

// Flat request body: credentials masked, other fields kept.
assert.deepEqual(
  redact({ email: 'a@b.c', password: 'p', confirmPassword: 'p', OTP: '1234', firstName: 'Ada' }),
  { email: 'a@b.c', password: REDACTED, confirmPassword: REDACTED, OTP: REDACTED, firstName: 'Ada' }
);

// Nested objects and arrays; key match is case-insensitive.
assert.deepEqual(
  redact({ user: { AccessToken: 'jwt', profile: { cards: [{ cvc: '123', last4: '4242' }] } } }),
  { user: { AccessToken: REDACTED, profile: { cards: [{ cvc: REDACTED, last4: '4242' }] } } }
);

// Cookies / headers.
assert.deepEqual(redact({ cookies: { accessToken: 'jwt' }, authorization: 'Bearer x' }), {
  cookies: REDACTED,
  authorization: REDACTED,
});

// Sequelize-style instance (toJSON) — e.g. a user row with a password hash.
const userRow = { toJSON: () => ({ id: 1, email: 'a@b.c', password: '$2a$hash', dataValues: undefined }) };
assert.deepEqual(redact(userRow), { id: 1, email: 'a@b.c', password: REDACTED, dataValues: undefined });

// Primitives, dates and null pass through; input is not mutated.
const body = { password: 'secret', when: new Date(0) };
const out = redact(body);
assert.equal(body.password, 'secret');
assert.equal(out.when.getTime(), 0);
assert.equal(redact(null), null);
assert.equal(redact('text'), 'text');

// Circular references do not throw.
const a = { name: 'x' };
a.self = a;
assert.equal(redact(a).self, '[Circular]');

console.log('redact.test.js: all assertions passed');

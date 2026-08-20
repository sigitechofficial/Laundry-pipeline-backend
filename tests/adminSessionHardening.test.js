'use strict';

const assert = require('assert/strict');
const jwt = require('jsonwebtoken');
const {
  signAdminAccessToken,
  getAdminJwtExpiresIn,
  getAdminJwtExpiresInMs,
  DEFAULT_ADMIN_JWT_EXPIRES_IN,
} = require('../utils/adminJwt');
const adminSignInRateLimit = require('../middlewares/adminSignInRateLimit');
const { tokenFromHeaderOrBody } = require('../utils/opsToken');

const prevSecret = process.env.JWT_ACCESS_SECRET;
const prevTtl = process.env.ADMIN_JWT_EXPIRES_IN;
process.env.JWT_ACCESS_SECRET = 'test-admin-jwt-secret-not-for-prod';
delete process.env.ADMIN_JWT_EXPIRES_IN;

assert.equal(getAdminJwtExpiresIn(), DEFAULT_ADMIN_JWT_EXPIRES_IN);
assert.equal(getAdminJwtExpiresInMs(), 8 * 60 * 60 * 1000);

const token = signAdminAccessToken({
  id: 42,
  email: 'admin@example.com',
  dvToken: 'device-1',
});
const decoded = jwt.decode(token);
assert.equal(decoded.id, 42);
assert.equal(typeof decoded.exp, 'number');
assert.ok(decoded.exp > Math.floor(Date.now() / 1000));
assert.ok(decoded.exp <= Math.floor(Date.now() / 1000) + 8 * 60 * 60 + 5);

const verified = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
assert.equal(typeof verified.exp, 'number');

assert.equal(typeof adminSignInRateLimit, 'function');
assert.equal(adminSignInRateLimit.ADMIN_SIGNIN_MAX, 10);
assert.equal(adminSignInRateLimit.ADMIN_SIGNIN_WINDOW_MS, 15 * 60 * 1000);

const fakeReq = {
  get(name) {
    if (String(name).toLowerCase() === 'x-db-sync-token') return 'header-secret';
    return undefined;
  },
  query: { token: 'query-must-be-ignored' },
  body: {},
};
assert.equal(
  tokenFromHeaderOrBody(fakeReq, {
    headers: ['x-db-sync-token'],
    bodyKeys: ['token'],
  }),
  'header-secret'
);

const queryOnlyReq = {
  get() {
    return undefined;
  },
  query: { token: 'query-must-be-ignored' },
  body: { token: 'body-secret' },
};
assert.equal(
  tokenFromHeaderOrBody(queryOnlyReq, {
    headers: ['x-db-sync-token'],
    bodyKeys: ['token'],
  }),
  'body-secret'
);

const queryLeakReq = {
  get() {
    return undefined;
  },
  query: { token: 'query-must-be-ignored' },
  body: {},
};
assert.equal(
  tokenFromHeaderOrBody(queryLeakReq, {
    headers: ['x-db-sync-token'],
    bodyKeys: ['token'],
  }),
  ''
);

if (prevSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
else process.env.JWT_ACCESS_SECRET = prevSecret;
if (prevTtl === undefined) delete process.env.ADMIN_JWT_EXPIRES_IN;
else process.env.ADMIN_JWT_EXPIRES_IN = prevTtl;

console.log('adminSessionHardening tests passed');

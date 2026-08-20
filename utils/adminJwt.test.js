'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const {
  signAdminAccessToken,
  DEFAULT_ADMIN_JWT_EXPIRES_IN,
} = require('./adminJwt');

function run() {
  const prevSecret = process.env.JWT_ACCESS_SECRET;
  const prevTtl = process.env.ADMIN_JWT_EXPIRES_IN;
  process.env.JWT_ACCESS_SECRET = 'unit-test-admin-jwt-secret';
  delete process.env.ADMIN_JWT_EXPIRES_IN;

  try {
    const authSrc = fs.readFileSync(
      path.join(__dirname, '../services/Admin/authService.js'),
      'utf8'
    );
    assert.match(
      authSrc,
      /signAdminAccessToken\(/,
      'admin and zone admin sign-in must issue tokens through signAdminAccessToken'
    );

    const token = signAdminAccessToken({
      id: 1,
      email: 'admin@example.com',
    });
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    assert.ok(Number.isFinite(decoded.exp), 'admin JWT must include exp');
    assert.ok(decoded.exp * 1000 > Date.now(), 'admin JWT exp must be in the future');
    assert.strictEqual(decoded.id, 1);
    assert.strictEqual(DEFAULT_ADMIN_JWT_EXPIRES_IN, '8h');

    const ttlSec = decoded.exp - decoded.iat;
    assert.ok(
      ttlSec > 7 * 3600 && ttlSec <= 8 * 3600 + 5,
      `default admin TTL should be ~8h, got ${ttlSec}s`
    );
  } finally {
    if (prevSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = prevSecret;
    if (prevTtl === undefined) delete process.env.ADMIN_JWT_EXPIRES_IN;
    else process.env.ADMIN_JWT_EXPIRES_IN = prevTtl;
  }

  console.log('adminJwt.test.js: all assertions passed');
}

run();

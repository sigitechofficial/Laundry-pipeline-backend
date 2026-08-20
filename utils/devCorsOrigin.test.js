'use strict';

const assert = require('assert/strict');
const {
  isPrivateLanHostname,
  isDevPrivateLanOrigin,
} = require('./devCorsOrigin');

assert.equal(isPrivateLanHostname('192.168.1.16'), true);
assert.equal(isPrivateLanHostname('10.0.0.4'), true);
assert.equal(isPrivateLanHostname('172.16.0.1'), true);
assert.equal(isPrivateLanHostname('127.0.0.1'), true);
assert.equal(isPrivateLanHostname('localhost'), true);
assert.equal(isPrivateLanHostname('8.8.8.8'), false);
assert.equal(isPrivateLanHostname('192.168.300.1'), false);

assert.equal(
  isDevPrivateLanOrigin('http://192.168.1.16:5174', 'development'),
  true
);
assert.equal(
  isDevPrivateLanOrigin('http://127.0.0.1:5174', 'development'),
  true
);
assert.equal(
  isDevPrivateLanOrigin('http://192.168.1.16:5174', 'production'),
  false
);
assert.equal(
  isDevPrivateLanOrigin('https://evil.example.com', 'development'),
  false
);
assert.equal(
  isDevPrivateLanOrigin('http://8.8.8.8:5174', 'development'),
  false
);

console.log('devCorsOrigin tests passed');

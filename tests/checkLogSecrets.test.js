'use strict';

const assert = require('assert/strict');
const { scan, findViolationsInSource } = require('../scripts/check-log-secrets');

const rulesFor = (src) => findViolationsInSource(src).map((v) => v.rule);

// Flagged: whole bodies/cookies, credential variables, whole user rows.
assert.deepEqual(rulesFor('console.log("body", req.body)'), ['whole request body/cookies/headers']);
assert.deepEqual(rulesFor('console.log(JSON.stringify(req.body, null, 2))'), ['whole request body/cookies/headers']);
assert.deepEqual(rulesFor('console.log("c", req.cookies)'), ['whole request body/cookies/headers']);
assert.deepEqual(rulesFor('console.log("OTP:", OTP)'), ['credential value']);
assert.deepEqual(rulesFor('console.log(`token ${accessToken}`)'), ['credential value']);
assert.deepEqual(rulesFor('console.log("user", userFind)'), ['whole user row']);
assert.deepEqual(rulesFor('console.error(\n  "multi",\n  redisToken\n)'), ['credential value']);

// Allowed: redacted values, safe fields, message text, lengths, opt-outs.
assert.deepEqual(rulesFor('console.log("body", redact(req.body))'), []);
assert.deepEqual(rulesFor('console.log(JSON.stringify(redact(req.body), null, 2))'), []);
assert.deepEqual(rulesFor('console.log("id", req.body.bookingId, userFind.id)'), []);
assert.deepEqual(rulesFor('console.error("OTP email failed:", err.message)'), []);
assert.deepEqual(rulesFor('console.log("len", accessToken.length)'), []);
assert.deepEqual(rulesFor('console.log("type", req.headers["content-type"])'), []);
assert.deepEqual(rulesFor('console.log(`\n** password: never logged\n** ${dbName}\n`)'), []);
assert.deepEqual(rulesFor('console.log("x", OTP) // log-secrets-ok: synthetic test value'), []);

// The codebase itself is clean (this is the regression guard).
assert.deepEqual(scan(), []);

console.log('checkLogSecrets tests passed');

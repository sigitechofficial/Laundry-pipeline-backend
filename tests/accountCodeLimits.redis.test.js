'use strict';

/**
 * The per-account code limits' Redis script (services/shared/passwordReset.js redisCodeLimiter)
 * on a real Redis: the hourly and daily issue caps, refusals not counted, the failed-guess
 * backoff and its schedule cap, the tally's memory and its clearing. tests/passwordReset.test.js
 * runs the same rules in memory (tests/memoryAccountCodes.js memoryCodeLimiter).
 *
 * Needs a Redis server (REDIS_URL, default redis://localhost:6379). It only writes and deletes
 * keys of its own made-up account ids, never another key.
 *   npm run test:otp-limits-redis
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const { createClient } = require('redis');

const {
  CODE_ISSUE_LIMITS,
  FAILED_GUESS_BACKOFF,
  MAX_FAILED_ATTEMPTS,
  PasswordResetError,
  redisCodeLimiter,
} = require('../services/shared/passwordReset');

const run = `itest-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const accounts = [];
const account = (name) => {
  const id = `${run}-${name}`;
  accounts.push(id);
  return id;
};
const keysOf = (id) => [
  ...Object.values(CODE_ISSUE_LIMITS).map((w) => `${w.key}:${id}`),
  `${FAILED_GUESS_BACKOFF.key}:${id}`,
];

async function waitOf(promise) {
  try {
    await promise;
    return 0;
  } catch (err) {
    assert.ok(err instanceof PasswordResetError, err && err.stack);
    assert.equal(err.reason, 'throttled');
    return err.details.retryAfterSeconds;
  }
}

const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) <= 2, `${label}: ${actual}s, expected about ${expected}s`);

async function main() {
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  await redis.connect();
  const limiter = redisCodeLimiter(redis);
  try {
    // ── Hourly cap, then the daily cap; refusals are not counted ──
    {
      const id = account('caps');
      const now = new Date();
      for (let i = 0; i < CODE_ISSUE_LIMITS.hourly.max; i += 1) {
        assert.equal(await waitOf(limiter.assertIssueAllowed(id, now)), 0, `code ${i + 1}`);
      }
      near(await waitOf(limiter.assertIssueAllowed(id, now)), CODE_ISSUE_LIMITS.hourly.windowSec, 'hourly cap');
      near(await redis.ttl(`${CODE_ISSUE_LIMITS.daily.key}:${id}`), CODE_ISSUE_LIMITS.daily.windowSec, 'day window');
      // The hour passing, for this made-up account only.
      await redis.del(`${CODE_ISSUE_LIMITS.hourly.key}:${id}`);
      for (let i = CODE_ISSUE_LIMITS.hourly.max; i < CODE_ISSUE_LIMITS.daily.max; i += 1) {
        assert.equal(await waitOf(limiter.assertIssueAllowed(id, now)), 0, `code ${i + 1}`);
      }
      near(await waitOf(limiter.assertIssueAllowed(id, now)), CODE_ISSUE_LIMITS.daily.windowSec, 'daily cap');
      await redis.del(`${CODE_ISSUE_LIMITS.hourly.key}:${id}`);
      near(await waitOf(limiter.assertIssueAllowed(id, now)), CODE_ISSUE_LIMITS.daily.windowSec,
        'the daily cap holds when the hour has room');
      assert.equal(await redis.get(`${CODE_ISSUE_LIMITS.daily.key}:${id}`), String(CODE_ISSUE_LIMITS.daily.max),
        'refused requests are not counted');
    }

    // ── Failed-guess backoff: free first lockout, then baseSec doubling ──
    {
      const id = account('backoff');
      const t0 = new Date('2026-11-24T10:00:00Z');
      const at = (sec) => new Date(t0.getTime() + sec * 1000);
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) await limiter.recordFailedGuess(id, t0);
      assert.equal(await waitOf(limiter.assertIssueAllowed(id, t0)), 0, 'one lockout is free');
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) await limiter.recordFailedGuess(id, t0);
      assert.equal(await waitOf(limiter.assertIssueAllowed(id, t0)), FAILED_GUESS_BACKOFF.baseSec);
      assert.equal(await waitOf(limiter.assertIssueAllowed(id, at(600))), FAILED_GUESS_BACKOFF.baseSec - 600);
      assert.equal(await waitOf(limiter.assertIssueAllowed(id, at(FAILED_GUESS_BACKOFF.baseSec))), 0);
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) await limiter.recordFailedGuess(id, at(1000));
      assert.equal(await waitOf(limiter.assertIssueAllowed(id, at(1000))), 2 * FAILED_GUESS_BACKOFF.baseSec);
      near(Math.round((await redis.pTTL(`${FAILED_GUESS_BACKOFF.key}:${id}`)) / 1000), FAILED_GUESS_BACKOFF.memorySec,
        'the tally is forgotten memorySec after the last wrong guess');
      // Far past the schedule: held at maxSec.
      for (let i = 0; i < 20 * MAX_FAILED_ATTEMPTS; i += 1) await limiter.recordFailedGuess(id, at(2000));
      assert.equal(await waitOf(limiter.assertIssueAllowed(id, at(2000))), FAILED_GUESS_BACKOFF.maxSec);
      // A correct code clears it.
      await limiter.clearFailedGuesses(id);
      assert.equal(await waitOf(limiter.assertIssueAllowed(id, at(2000))), 0);
    }

    // ── The longest wait wins when several limits apply ──
    {
      const id = account('both');
      const now = new Date();
      for (let i = 0; i < CODE_ISSUE_LIMITS.hourly.max; i += 1) await limiter.assertIssueAllowed(id, now);
      for (let i = 0; i < 10 * MAX_FAILED_ATTEMPTS; i += 1) await limiter.recordFailedGuess(id, now);
      assert.equal(await waitOf(limiter.assertIssueAllowed(id, now)), FAILED_GUESS_BACKOFF.maxSec);
    }
  } finally {
    await redis.del(accounts.flatMap(keysOf));
    await redis.quit();
  }
  console.log('accountCodeLimits.redis.test.js: all assertions passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

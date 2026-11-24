'use strict';

/**
 * The emailed account code (services/shared/passwordReset.js, services/shared/otpCode.js), the
 * lifecycle shared by the customer, agent and driver APIs for sign-up verification and
 * password reset:
 *  - the account is the code owner, never a client-supplied userId (one that is sent is checked);
 *  - a code is digits only, must be live (issued, unused, unexpired) and is single use;
 *  - a used, invalidated or superseded code (OTP NULL) never verifies anything, in any flow;
 *  - wrong guesses are limited per code, and codes per account per window;
 *  - a new code ends the earlier code's lifecycle (verified flag, reset window, wrong guesses);
 *  - a reset must be completed within its own window and ends every session of the account.
 * The flows' use of it is tested in tests/accountCodeCallSites.test.js.
 */

const assert = require('assert/strict');
const path = require('path');
const { Op } = require('sequelize');

const {
  OTP_CODE_LENGTH,
  OTP_TTL_MS,
  generateOtpCode,
  freshCodeColumns,
  normalizeSubmittedCode,
} = require('../services/shared/otpCode');
const {
  MAX_FAILED_ATTEMPTS,
  PASSWORD_RESET_WINDOW_MS,
  CODE_ISSUE_LIMIT,
  PasswordResetError,
  codeState,
  resetState,
  toId,
  sequelizeResetStore,
  redisIssueLimiter,
  toHttpError,
} = require('../services/shared/passwordReset');
const { makeAccountCodeWorld: makeWorld, wrongCode } = require('./memoryAccountCodes');

const AGENT = [4];
const CUSTOMER = [2];
const DRIVER = [3];

async function rejectsWith(promise, reason) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof PasswordResetError, `expected PasswordResetError, got ${err && err.stack}`);
    assert.equal(err.reason, reason);
    return true;
  });
}

async function run() {
  // ── Code format: digits only, full 4-digit space, numeric submissions keep leading zeros ──
  assert.equal(OTP_CODE_LENGTH, 4);
  assert.equal(OTP_TTL_MS, 60 * 1000, 'the platform code lifetime is unchanged');
  for (let i = 0; i < 2000; i += 1) assert.match(generateOtpCode(), /^\d{4}$/);
  assert.equal(normalizeSubmittedCode(421), '0421');
  assert.equal(normalizeSubmittedCode(' 0421 '), '0421');
  assert.equal(normalizeSubmittedCode(undefined), '');
  assert.equal(normalizeSubmittedCode({ $ne: null }), '', 'objects never reach the query');
  assert.deepEqual(
    freshCodeColumns({ code: '0042', requestedAt: new Date(0), expiresAt: new Date(1) }),
    {
      OTP: '0042', reqAt: new Date(0), expirtAt: new Date(1), failedAttempts: 0,
      verifiedAtForgetCase: false, resetExpiresAt: null,
    },
    'a new code clears the earlier lifecycle'
  );

  // ── Pure state classification ──
  const at = new Date('2026-11-24T10:00:00Z');
  const later = new Date(at.getTime() + 1000);
  assert.equal(codeState(null, at), 'missing');
  assert.equal(codeState({ OTP: '1234', expirtAt: later, failedAttempts: 0 }, at), 'live');
  assert.equal(codeState({ OTP: '1234', expirtAt: at, failedAttempts: 0 }, at), 'live', 'valid up to expirtAt');
  assert.equal(codeState({ OTP: '1234', expirtAt: new Date(at - 1), failedAttempts: 0 }, at), 'expired');
  assert.equal(codeState({ OTP: '1234', expirtAt: null, failedAttempts: 0 }, at), 'expired', 'no expiry is not valid');
  assert.equal(codeState({ OTP: null, expirtAt: later, failedAttempts: 0 }, at), 'invalidated');
  assert.equal(codeState({ OTP: null, expirtAt: later, failedAttempts: MAX_FAILED_ATTEMPTS }, at), 'locked');
  assert.equal(codeState({ OTP: null, expirtAt: null, failedAttempts: 0 }, at), 'invalidated', 'a used code never matches');
  assert.equal(resetState({ verifiedAtForgetCase: false, resetExpiresAt: later }, at), 'not_verified');
  assert.equal(resetState({ verifiedAtForgetCase: null, resetExpiresAt: later }, at), 'not_verified', 'only true is verified');
  assert.equal(resetState({ verifiedAtForgetCase: true, resetExpiresAt: new Date(at - 1) }, at), 'reset_expired');
  assert.equal(resetState({ verifiedAtForgetCase: true, resetExpiresAt: null }, at), 'reset_expired', 'no window is no reset');
  assert.equal(resetState({ verifiedAtForgetCase: true, resetExpiresAt: later, expirtAt: null }, at), 'ready',
    'the reset window is not the code expiry');
  assert.equal(toId(7), 7);
  assert.equal(toId(' 42 '), 42);
  for (const bad of [0, -1, 1.5, '', 'abc', '1e3', { $gt: 0 }, [1], null, undefined, true]) {
    assert.equal(toId(bad), null, `not an id: ${JSON.stringify(bad)}`);
  }

  // ── Happy path: owner's password changes, sessions end, everything is single use ──
  {
    const { state, reset, codeOf } = makeWorld();
    const { otpId, code, created } = await reset.issueCode({ userId: 10 });
    assert.equal(created, true);
    assert.equal(code, codeOf(otpId));
    assert.deepEqual(await reset.verifyResetCode({ otpId: String(otpId), code, userTypeIds: AGENT }), { otpId, userId: 10 });
    await rejectsWith(reset.verifyResetCode({ otpId, code, userTypeIds: AGENT }), 'invalidated'); // single use
    assert.deepEqual(await reset.resetPassword({ otpId, userId: '10', password: 'n3w!', userTypeIds: AGENT }), { userId: 10 });
    assert.equal(state.users.get(10).password, 'hash(n3w!)');
    assert.deepEqual(state.ended, [10], 'every session of the account ended');
    await rejectsWith(reset.resetPassword({ otpId, password: 'again', userTypeIds: AGENT }), 'not_verified');
    assert.equal(state.users.get(10).password, 'hash(n3w!)', 'a verified reset is used once');
  }

  // ── The O-12 attack: a verified code of account A cannot set account B's password ──
  {
    const { state, reset } = makeWorld();
    const mine = await reset.issueCode({ userId: 30 });
    await reset.verifyResetCode({ otpId: mine.otpId, code: mine.code, userTypeIds: AGENT });
    await rejectsWith(
      reset.resetPassword({ otpId: mine.otpId, userId: 10, password: 'pwned', userTypeIds: AGENT }),
      'user_mismatch'
    );
    assert.equal(state.users.get(10).password, 'old-agent', 'victim untouched');
    assert.equal(state.users.get(30).password, 'old-other-agent', 'a refused request changes nothing');
    // Without a userId (accepted and ignored) the owner, not anyone else, is reset.
    await reset.resetPassword({ otpId: mine.otpId, password: 'mine', userTypeIds: AGENT });
    assert.equal(state.users.get(30).password, 'hash(mine)');
    assert.equal(state.users.get(10).password, 'old-agent');
  }

  // ── Not verified, expired code, expired reset ──
  {
    const { state, reset, advance } = makeWorld();
    const a = await reset.issueCode({ userId: 10 });
    await rejectsWith(reset.resetPassword({ otpId: a.otpId, password: 'x', userTypeIds: AGENT }), 'not_verified');
    advance(OTP_TTL_MS + 1);
    await rejectsWith(reset.verifyResetCode({ otpId: a.otpId, code: a.code, userTypeIds: AGENT }), 'expired');

    const b = await reset.issueCode({ userId: 10 });
    await reset.verifyResetCode({ otpId: b.otpId, code: b.code, userTypeIds: AGENT });
    // The reset window is its own duration, longer than the code's, and not the code expiry.
    assert.ok(PASSWORD_RESET_WINDOW_MS > OTP_TTL_MS);
    advance(OTP_TTL_MS + 1);
    assert.equal(state.codes[0].OTP, null);
    advance(PASSWORD_RESET_WINDOW_MS - OTP_TTL_MS - 2);
    await reset.resetPassword({ otpId: b.otpId, password: 'in-time', userTypeIds: AGENT });
    assert.equal(state.users.get(10).password, 'hash(in-time)');

    const c = await reset.issueCode({ userId: 10 });
    await reset.verifyResetCode({ otpId: c.otpId, code: c.code, userTypeIds: AGENT });
    advance(PASSWORD_RESET_WINDOW_MS + 1);
    await rejectsWith(reset.resetPassword({ otpId: c.otpId, password: 'x', userTypeIds: AGENT }), 'reset_expired');
    assert.equal(state.users.get(10).password, 'hash(in-time)');
    await rejectsWith(reset.resetPassword({ otpId: c.otpId, password: '', userTypeIds: AGENT }), 'password_required');
    await rejectsWith(reset.resetPassword({ otpId: c.otpId, userTypeIds: AGENT }), 'password_required');
  }

  // ── Wrong guesses: limited per code, the code is invalidated at the limit ──
  {
    const { reset } = makeWorld();
    const { otpId, code } = await reset.issueCode({ userId: 10 });
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await assert.rejects(reset.verifyResetCode({ otpId, code: wrongCode(code), userTypeIds: AGENT }), (err) => {
        assert.equal(err.reason, 'incorrect');
        assert.equal(err.details.attemptsRemaining, MAX_FAILED_ATTEMPTS - i);
        return true;
      });
    }
    await rejectsWith(reset.verifyResetCode({ otpId, code: wrongCode(code), userTypeIds: AGENT }), 'locked');
    await rejectsWith(reset.verifyResetCode({ otpId, code, userTypeIds: AGENT }), 'locked', 'the right code no longer works');

    // A new code starts over (and the earlier lockout ends with it).
    const again = await reset.issueCode({ userId: 10 });
    assert.equal(again.otpId, otpId, 'one row per account');
    await reset.verifyResetCode({ otpId, code: again.code, userTypeIds: AGENT });
  }

  // ── Parallel guesses cannot exceed the limit ──
  {
    const { reset, state } = makeWorld();
    const { otpId, code } = await reset.issueCode({ userId: 10 });
    const guesses = Array.from({ length: 20 }, () =>
      reset.verifyResetCode({ otpId, code: wrongCode(code), userTypeIds: AGENT }).catch((e) => e.reason));
    const reasons = await Promise.all(guesses);
    assert.equal(reasons.filter((r) => r === 'incorrect' || r === 'locked').length, 20);
    assert.ok(state.codes[0].failedAttempts <= MAX_FAILED_ATTEMPTS);
    assert.equal(state.codes[0].OTP, null);
  }

  // ── A new code resets the verified flag (forget request after a verification) ──
  {
    const { reset } = makeWorld();
    const a = await reset.issueCode({ userId: 10 });
    await reset.verifyResetCode({ otpId: a.otpId, code: a.code, userTypeIds: AGENT });
    await reset.issueCode({ userId: 10 });
    await rejectsWith(reset.resetPassword({ otpId: a.otpId, password: 'x', userTypeIds: AGENT }), 'not_verified');
  }

  // ── Codes per account per window ──
  {
    const { reset } = makeWorld();
    for (let i = 0; i < CODE_ISSUE_LIMIT.max; i += 1) await reset.issueCode({ userId: 10 });
    await rejectsWith(reset.issueCode({ userId: 10 }), 'throttled');
    await reset.issueCode({ userId: 30 }); // other accounts are unaffected
  }

  // ── Account types: a flow only finds codes of the accounts it serves ──
  {
    const { reset, state } = makeWorld();
    const c = await reset.issueCode({ userId: 20 }); // a customer
    await rejectsWith(reset.verifyResetCode({ otpId: c.otpId, code: c.code, userTypeIds: AGENT }), 'not_found');
    await reset.verifyResetCode({ otpId: c.otpId, code: c.code, userTypeIds: CUSTOMER });
    await rejectsWith(reset.resetPassword({ otpId: c.otpId, password: 'x', userTypeIds: AGENT }), 'not_found');
    await reset.resetPassword({ otpId: c.otpId, password: 'x', userTypeIds: CUSTOMER });
    assert.equal(state.users.get(20).password, 'hash(x)');
    await rejectsWith(reset.verifyResetCode({ otpId: 999, code: '1234', userTypeIds: AGENT }), 'not_found');
    await rejectsWith(reset.verifyResetCode({ otpId: undefined, code: '1234', userTypeIds: AGENT }), 'not_found');
  }

  // ── A flow's own accept rule (skipCodeCheck) still ends in the same single-use reset ──
  {
    const { reset, state } = makeWorld();
    const c = await reset.issueCode({ userId: 20 });
    await reset.verifyResetCode({ otpId: c.otpId, code: 'test', userTypeIds: CUSTOMER, skipCodeCheck: true });
    await rejectsWith(reset.verifyResetCode({ otpId: c.otpId, code: c.code, userTypeIds: CUSTOMER }), 'invalidated');
    await reset.resetPassword({ otpId: c.otpId, userId: 20, password: 'p', userTypeIds: CUSTOMER });
    assert.deepEqual(state.ended, [20]);
  }

  // ── If the sessions cannot be ended, the password is not changed and the reset stays open ──
  {
    const { reset, state } = makeWorld();
    const c = await reset.issueCode({ userId: 10 });
    await reset.verifyResetCode({ otpId: c.otpId, code: c.code, userTypeIds: AGENT });
    state.failSessionsEnd = true;
    await assert.rejects(reset.resetPassword({ otpId: c.otpId, password: 'p', userTypeIds: AGENT }), /redis down/);
    assert.equal(state.users.get(10).password, 'old-agent');
    state.failSessionsEnd = false;
    await reset.resetPassword({ otpId: c.otpId, password: 'p', userTypeIds: AGENT });
    assert.equal(state.users.get(10).password, 'hash(p)');
  }

  // ── Sign-up verification: owner-bound, live, single use, and it opens no reset ──
  {
    const { state, reset, row } = makeWorld();
    const a = await reset.issueCode({ userId: 20 });
    await rejectsWith(reset.verifySignupCode({ otpId: a.otpId, userId: 30, code: a.code, userTypeIds: CUSTOMER }),
      'user_mismatch');
    assert.equal(row(a.otpId).OTP, a.code, 'a refused request does not use the code');
    assert.deepEqual(
      await reset.verifySignupCode({ otpId: String(a.otpId), userId: '20', code: a.code, userTypeIds: CUSTOMER }),
      { otpId: a.otpId, userId: 20 }
    );
    assert.equal(row(a.otpId).verifiedAtForgetCase, false);
    assert.equal(row(a.otpId).resetExpiresAt, null);
    await rejectsWith(reset.verifySignupCode({ otpId: a.otpId, userId: 20, code: a.code, userTypeIds: CUSTOMER }),
      'invalidated');
    await rejectsWith(reset.resetPassword({ otpId: a.otpId, password: 'x', userTypeIds: CUSTOMER }), 'not_verified');
    await rejectsWith(reset.verifyResetCode({ otpId: a.otpId, code: a.code, userTypeIds: CUSTOMER }), 'invalidated');
    assert.equal(state.users.get(20).password, 'old-customer');
    // Without userId the owner is verified (never anyone else); without otpId, the account's own row.
    const b = await reset.issueCode({ userId: 20 });
    assert.deepEqual(await reset.verifySignupCode({ otpId: b.otpId, code: b.code, userTypeIds: CUSTOMER }),
      { otpId: b.otpId, userId: 20 });
    const c = await reset.issueCode({ userId: 40 });
    assert.deepEqual(await reset.verifySignupCode({ userId: '40', code: c.code, userTypeIds: DRIVER }),
      { otpId: c.otpId, userId: 40 });
    await rejectsWith(reset.verifySignupCode({ code: c.code, userTypeIds: DRIVER }), 'not_found');
    await rejectsWith(reset.verifySignupCode({ userId: { $gt: 0 }, code: c.code, userTypeIds: DRIVER }), 'not_found');
    // A flow only finds its own kind of account, by otpId or by userId.
    const d = await reset.issueCode({ userId: 10 });
    await rejectsWith(reset.verifySignupCode({ userId: 10, code: d.code, userTypeIds: DRIVER }), 'not_found');
    await rejectsWith(reset.verifySignupCode({ otpId: d.otpId, code: d.code, userTypeIds: CUSTOMER }), 'not_found');
    assert.equal(row(d.otpId).OTP, d.code);
  }

  // ── O-12-R1: a used, locked, superseded or never-issued code verifies nothing, code or no code ──
  {
    const { reset, row, state } = makeWorld();
    const noCodes = [undefined, null, '', 'null', 0];
    const attempts = async (otpId, owner, types) => {
      for (const code of noCodes) {
        for (const userId of [undefined, owner]) {
          await assert.rejects(reset.verifySignupCode({ otpId, userId, code, userTypeIds: types }), (err) => {
            assert.ok(err instanceof PasswordResetError);
            assert.ok(['invalidated', 'locked', 'not_found', 'expired'].includes(err.reason), err.reason);
            return true;
          });
        }
        await rejectsWith(reset.verifySignupCode({ otpId, userId: owner + 1, code, userTypeIds: types }),
          'user_mismatch');
        await assert.rejects(reset.verifyResetCode({ otpId, code, userTypeIds: types }));
      }
    };
    // Used by a completed reset (OTP NULL, reset closed).
    const used = await reset.issueCode({ userId: 20 });
    await reset.verifyResetCode({ otpId: used.otpId, code: used.code, userTypeIds: CUSTOMER });
    await reset.resetPassword({ otpId: used.otpId, password: 'p', userTypeIds: CUSTOMER });
    assert.equal(row(used.otpId).OTP, null);
    await attempts(used.otpId, 20, CUSTOMER);
    // Locked by wrong guesses.
    const locked = await reset.issueCode({ userId: 10 });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await assert.rejects(reset.verifySignupCode({ otpId: locked.otpId, code: wrongCode(locked.code), userTypeIds: AGENT }));
    }
    assert.equal(row(locked.otpId).OTP, null);
    await attempts(locked.otpId, 10, AGENT);
    await rejectsWith(reset.verifySignupCode({ otpId: locked.otpId, code: locked.code, userTypeIds: AGENT }), 'locked');
    // Superseded: an account's extra row is emptied by a new code.
    state.codes.push({ id: 99, userId: 40, OTP: '1111', expirtAt: new Date(state.clock.getTime() + 1000), failedAttempts: 0 });
    state.codes.push({ id: 100, userId: 40, OTP: '2222', expirtAt: new Date(state.clock.getTime() + 1000), failedAttempts: 0 });
    const fresh = await reset.issueCode({ userId: 40 });
    assert.equal(fresh.otpId, 99, 'the lowest-id row holds the code');
    await attempts(100, 40, DRIVER);
    await rejectsWith(reset.verifySignupCode({ otpId: 100, code: '2222', userTypeIds: DRIVER }), 'invalidated');
    // Never issued: a row with no code.
    state.codes.push({ id: 101, userId: 30, OTP: null, expirtAt: null, failedAttempts: 0 });
    await attempts(101, 30, AGENT);
    assert.equal(state.users.get(30).password, 'old-other-agent');
  }

  // ── Sign-up: the flow's own accept rule (skipCodeCheck) uses the row's code up, opens no reset ──
  {
    const { reset, row } = makeWorld();
    const c = await reset.issueCode({ userId: 20 });
    await rejectsWith(
      reset.verifySignupCode({ otpId: c.otpId, userId: 30, code: 'test', userTypeIds: CUSTOMER, skipCodeCheck: true }),
      'user_mismatch'
    );
    await reset.verifySignupCode({ userId: 20, code: 'test', userTypeIds: CUSTOMER, skipCodeCheck: true });
    assert.equal(row(c.otpId).OTP, null);
    await rejectsWith(reset.resetPassword({ otpId: c.otpId, password: 'x', userTypeIds: CUSTOMER }), 'not_verified');
    await rejectsWith(
      reset.verifySignupCode({ userId: 10, code: 'test', userTypeIds: CUSTOMER, skipCodeCheck: true }),
      'not_found',
      'only accounts of the flow, and only with a code row'
    );
  }

  // ── Concurrent correct submissions: one wins, the other is told the code is used ──
  {
    const { reset } = makeWorld();
    const c = await reset.issueCode({ userId: 20 });
    const results = await Promise.all([1, 2].map(() =>
      reset.verifySignupCode({ otpId: c.otpId, code: c.code, userTypeIds: CUSTOMER }).then(() => 'ok', (e) => e.reason)));
    assert.deepEqual(results.sort(), ['invalidated', 'ok']);
  }

  // ── Sign-up re-issue counts against the same per-account code limit ──
  {
    const { reset } = makeWorld();
    for (let i = 0; i < CODE_ISSUE_LIMIT.max - 1; i += 1) await reset.reserveIssue({ userId: 20 });
    await reset.issueCode({ userId: 20 });
    await rejectsWith(reset.reserveIssue({ userId: 20 }), 'throttled');
    await rejectsWith(reset.issueCode({ userId: 20 }), 'throttled');
  }

  // ── HTTP mapping keeps each API's statuses ──
  {
    const err = new PasswordResetError('incorrect', { attemptsRemaining: 2 });
    assert.equal(toHttpError(err).statusCode, 401);
    assert.equal(toHttpError(err, { incorrect: 400 }).statusCode, 400);
    assert.deepEqual(toHttpError(err).details, { attemptsRemaining: 2 });
    assert.equal(toHttpError(err, {}, { incorrect: 'Invalid OTP' }).message, 'Invalid OTP');
    assert.equal(toHttpError(err, {}, { locked: 'other' }).message, err.message);
    assert.equal(toHttpError(new PasswordResetError('locked')).statusCode, 429);
    assert.deepEqual(toHttpError(new PasswordResetError('not_found')).details, { message: 'Please resend OTP to continue' });
    const other = new Error('db');
    assert.equal(toHttpError(other), other, 'other errors pass through');
  }

  // ── Redis issue limiter: the window starts with the first code and never loses its expiry ──
  {
    const calls = [];
    const kv = new Map();
    const redis = {
      async set(key, value, opts) { calls.push(['set', key, opts]); if (!kv.has(key)) kv.set(key, Number(value)); },
      async incr(key) { kv.set(key, (kv.get(key) || 0) + 1); return kv.get(key); },
      async ttl() { return 1234; },
    };
    const limiter = redisIssueLimiter(redis, { windowSec: 3600, max: 2 });
    await limiter.assertAllowed(7);
    await limiter.assertAllowed(7);
    await assert.rejects(limiter.assertAllowed(7), (e) => e.reason === 'throttled' && e.details.retryAfterSeconds === 1234);
    assert.deepEqual(calls[0], ['set', 'rl:otp:issue:u:7', { EX: 3600, NX: true }]);
    const down = redisIssueLimiter({ async set() { throw new Error('ECONNREFUSED'); } });
    await assert.rejects(down.assertAllowed(7), /ECONNREFUSED/, 'fails closed');
  }

  // ── The Sequelize store's guards are in its WHERE clauses (atomic under concurrency) ──
  {
    const updates = [];
    const otpVerification = {
      async update(values, opts) { updates.push({ values, where: opts.where }); return [1]; },
    };
    const store = sequelizeResetStore({
      sequelize: { literal: (s) => ({ literal: s }) },
      users: { async update(values, opts) { updates.push({ values, where: opts.where, users: true }); return [1]; } },
      otpVerification,
    });
    const now = new Date();
    await store.reserveAttempt(5, now, 5);
    assert.deepEqual(updates[0].where, {
      id: 5, OTP: { [Op.not]: null }, failedAttempts: { [Op.lt]: 5 }, expirtAt: { [Op.gte]: now },
    });
    assert.deepEqual(updates[0].values, { failedAttempts: { literal: 'failedAttempts + 1' } });
    await store.consumeCode(5, '0421', now, { verifiedAtForgetCase: true, resetExpiresAt: now });
    assert.deepEqual(updates[1].where, { id: 5, OTP: '0421', expirtAt: { [Op.gte]: now } });
    assert.deepEqual(updates[1].values, {
      OTP: null, failedAttempts: 0, verifiedAtForgetCase: true, resetExpiresAt: now,
    }, 'the code is used up; expirtAt is left as the code expiry');
    assert.equal(await store.consumeCode(5, '', now, {}), false, 'an empty code never matches');
    await store.consumeVerifiedReset(5, 10, now, { id: 'tx' });
    assert.deepEqual(updates[2].where, {
      id: 5, userId: 10, verifiedAtForgetCase: true, resetExpiresAt: { [Op.gte]: now },
    });
    assert.deepEqual(updates[2].values, { verifiedAtForgetCase: false, resetExpiresAt: null });
    await store.setPassword(10, 'h', { id: 'tx' });
    assert.deepEqual(updates[3], { values: { password: 'h' }, where: { id: 10 }, users: true });
  }

  // ── endAllAppSessions: every session and every push token of the account ──
  {
    const redisKeys = new Map([['id-10', { a: 't1', b: 't2' }], ['id-11', { c: 't3' }]]);
    let destroyed = null;
    const inject = (rel, exports) => {
      const p = require.resolve(path.join(__dirname, '..', rel));
      require.cache[p] = { id: p, filename: p, loaded: true, exports };
    };
    inject('redis/redis', { async del(key) { return redisKeys.delete(key) ? 1 : 0; } });
    inject('models', { deviceToken: { async destroy(opts) { destroyed = opts; return 2; } } });
    const { endAllAppSessions } = require('../utils/appSession');
    await endAllAppSessions(10, { transaction: { id: 'tx' } });
    assert.equal(redisKeys.has('id-10'), false);
    assert.equal(redisKeys.has('id-11'), true, 'other accounts keep their sessions');
    assert.deepEqual(destroyed, { where: { userId: 10 }, transaction: { id: 'tx' } });
    await assert.rejects(endAllAppSessions(null), /userId is required/);
  }

  console.log('passwordReset.test.js: all assertions passed');
}

run().catch((e) => { console.error(e); process.exit(1); });

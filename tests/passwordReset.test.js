'use strict';

/**
 * Password reset by emailed code (services/shared/passwordReset.js, services/shared/otpCode.js),
 * the lifecycle shared by the customer, agent and driver APIs:
 *  - the password changed is the code owner's, never a client-supplied userId's;
 *  - a code is digits only, must be live (issued, unexpired) and is single use;
 *  - wrong guesses are limited per code, and codes per account per window;
 *  - a new code ends the earlier code's lifecycle (verified flag, wrong guesses);
 *  - a reset ends every session of the account, in the same transaction.
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
  RESET_GRANT_TTL_MS,
  CODE_ISSUE_LIMIT,
  PasswordResetError,
  codeState,
  resetState,
  createPasswordReset,
  sequelizeResetStore,
  redisIssueLimiter,
  toHttpError,
} = require('../services/shared/passwordReset');

// ── In-memory store with the same conditional-update semantics as sequelizeResetStore ──────
function makeWorld() {
  const state = {
    users: new Map([
      [10, { id: 10, userTypeId: 4, password: 'old-agent' }],
      [20, { id: 20, userTypeId: 2, password: 'old-customer' }],
      [30, { id: 30, userTypeId: 4, password: 'old-other-agent' }],
    ]),
    codes: [],
    nextId: 1,
    ended: [],
    clock: new Date('2026-11-24T10:00:00Z'),
    failSessionsEnd: false,
  };
  const live = (row, at) => row.expirtAt && new Date(row.expirtAt) >= at;
  const byId = (id) => state.codes.find((r) => String(r.id) === String(id));

  const store = {
    async findCode(otpId) {
      const r = byId(otpId);
      return r ? { ...r } : null;
    },
    async findAccount(userId, types) {
      const u = state.users.get(userId);
      return u && types.includes(u.userTypeId) ? { id: u.id } : null;
    },
    async writeFreshCode(userId, columns) {
      const rows = state.codes.filter((r) => r.userId === userId).sort((a, b) => a.id - b.id);
      if (!rows.length) {
        const row = { id: state.nextId++, userId, ...columns };
        state.codes.push(row);
        return { otpId: row.id, created: true };
      }
      Object.assign(rows[0], columns);
      rows.slice(1).forEach((r) => Object.assign(r, { OTP: null, expirtAt: null, verifiedAtForgetCase: false }));
      return { otpId: rows[0].id, created: false };
    },
    async reserveAttempt(otpId, at, max) {
      const r = byId(otpId);
      if (!r || !r.OTP || r.failedAttempts >= max || !live(r, at)) return false;
      r.failedAttempts += 1;
      return true;
    },
    async consumeCode(otpId, code, at, until) {
      const r = byId(otpId);
      if (!code || !r || r.OTP !== code || !live(r, at)) return false;
      Object.assign(r, { OTP: null, failedAttempts: 0, verifiedAtForgetCase: true, expirtAt: until });
      return true;
    },
    async markVerified(otpId, until) {
      const r = byId(otpId);
      Object.assign(r, { OTP: null, failedAttempts: 0, verifiedAtForgetCase: true, expirtAt: until });
      return true;
    },
    async invalidateCode(otpId, max) {
      const r = byId(otpId);
      if (r && r.failedAttempts >= max) r.OTP = null;
    },
    async consumeVerifiedReset(otpId, userId, at, tx) {
      assert.ok(tx && tx.pending, 'consumed inside the transaction');
      const r = byId(otpId);
      if (!r || r.userId !== userId || !r.verifiedAtForgetCase || !live(r, at)) return false;
      tx.pending.push(() => Object.assign(r, { verifiedAtForgetCase: false, expirtAt: null }));
      return true;
    },
    async setPassword(userId, hash, tx) {
      assert.ok(tx && tx.pending, 'password written inside the transaction');
      const u = state.users.get(userId);
      if (!u) return false;
      tx.pending.push(() => { u.password = hash; });
      return true;
    },
    async transaction(fn) {
      const tx = { pending: [] };
      const result = await fn(tx);
      tx.pending.forEach((commit) => commit());
      return result;
    },
  };

  const issued = new Map();
  const limiter = {
    async assertAllowed(userId) {
      const n = (issued.get(userId) || 0) + 1;
      issued.set(userId, n);
      if (n > CODE_ISSUE_LIMIT.max) throw new PasswordResetError('throttled', { retryAfterSeconds: 60 });
    },
  };

  const reset = createPasswordReset({
    store,
    issueLimiter: limiter,
    hashPassword: async (p) => `hash(${p})`,
    endAllSessions: async (userId, { transaction }) => {
      assert.ok(transaction && transaction.pending, 'sessions end inside the reset transaction');
      if (state.failSessionsEnd) throw new Error('redis down');
      state.ended.push(userId);
    },
    now: () => state.clock,
  });
  const advance = (ms) => { state.clock = new Date(state.clock.getTime() + ms); };
  const codeOf = (otpId) => byId(otpId).OTP;
  return { state, reset, advance, codeOf, issued };
}

const AGENT = [4];
const CUSTOMER = [2];

async function rejectsWith(promise, reason) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof PasswordResetError, `expected PasswordResetError, got ${err && err.stack}`);
    assert.equal(err.reason, reason);
    return true;
  });
}

const wrongCode = (code) => String((Number(code) + 1) % 10000).padStart(4, '0');

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
    { OTP: '0042', reqAt: new Date(0), expirtAt: new Date(1), failedAttempts: 0, verifiedAtForgetCase: false },
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
  assert.equal(resetState({ verifiedAtForgetCase: false, expirtAt: later }, at), 'not_verified');
  assert.equal(resetState({ verifiedAtForgetCase: null, expirtAt: later }, at), 'not_verified', 'only true is verified');
  assert.equal(resetState({ verifiedAtForgetCase: true, expirtAt: new Date(at - 1) }, at), 'reset_expired');
  assert.equal(resetState({ verifiedAtForgetCase: true, expirtAt: later }, at), 'ready');

  // ── Happy path: owner's password changes, sessions end, everything is single use ──
  {
    const { state, reset, codeOf } = makeWorld();
    const { otpId, code, created } = await reset.issueCode({ userId: 10 });
    assert.equal(created, true);
    assert.equal(code, codeOf(otpId));
    assert.deepEqual(await reset.verifyCode({ otpId: String(otpId), code, userTypeIds: AGENT }), { otpId, userId: 10 });
    await rejectsWith(reset.verifyCode({ otpId, code, userTypeIds: AGENT }), 'invalidated'); // single use
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
    await reset.verifyCode({ otpId: mine.otpId, code: mine.code, userTypeIds: AGENT });
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
    await rejectsWith(reset.verifyCode({ otpId: a.otpId, code: a.code, userTypeIds: AGENT }), 'expired');

    const b = await reset.issueCode({ userId: 10 });
    await reset.verifyCode({ otpId: b.otpId, code: b.code, userTypeIds: AGENT });
    advance(RESET_GRANT_TTL_MS + 1);
    await rejectsWith(reset.resetPassword({ otpId: b.otpId, password: 'x', userTypeIds: AGENT }), 'reset_expired');
    assert.equal(state.users.get(10).password, 'old-agent');
    await rejectsWith(reset.resetPassword({ otpId: b.otpId, password: '', userTypeIds: AGENT }), 'password_required');
    await rejectsWith(reset.resetPassword({ otpId: b.otpId, userTypeIds: AGENT }), 'password_required');
  }

  // ── Wrong guesses: limited per code, the code is invalidated at the limit ──
  {
    const { reset } = makeWorld();
    const { otpId, code } = await reset.issueCode({ userId: 10 });
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await assert.rejects(reset.verifyCode({ otpId, code: wrongCode(code), userTypeIds: AGENT }), (err) => {
        assert.equal(err.reason, 'incorrect');
        assert.equal(err.details.attemptsRemaining, MAX_FAILED_ATTEMPTS - i);
        return true;
      });
    }
    await rejectsWith(reset.verifyCode({ otpId, code: wrongCode(code), userTypeIds: AGENT }), 'locked');
    await rejectsWith(reset.verifyCode({ otpId, code, userTypeIds: AGENT }), 'locked', 'the right code no longer works');

    // A new code starts over (and the earlier lockout ends with it).
    const again = await reset.issueCode({ userId: 10 });
    assert.equal(again.otpId, otpId, 'one row per account');
    await reset.verifyCode({ otpId, code: again.code, userTypeIds: AGENT });
  }

  // ── Parallel guesses cannot exceed the limit ──
  {
    const { reset, state } = makeWorld();
    const { otpId, code } = await reset.issueCode({ userId: 10 });
    const guesses = Array.from({ length: 20 }, () =>
      reset.verifyCode({ otpId, code: wrongCode(code), userTypeIds: AGENT }).catch((e) => e.reason));
    const reasons = await Promise.all(guesses);
    assert.equal(reasons.filter((r) => r === 'incorrect' || r === 'locked').length, 20);
    assert.ok(state.codes[0].failedAttempts <= MAX_FAILED_ATTEMPTS);
    assert.equal(state.codes[0].OTP, null);
  }

  // ── A new code resets the verified flag (forget request after a verification) ──
  {
    const { reset } = makeWorld();
    const a = await reset.issueCode({ userId: 10 });
    await reset.verifyCode({ otpId: a.otpId, code: a.code, userTypeIds: AGENT });
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
    await rejectsWith(reset.verifyCode({ otpId: c.otpId, code: c.code, userTypeIds: AGENT }), 'not_found');
    await reset.verifyCode({ otpId: c.otpId, code: c.code, userTypeIds: CUSTOMER });
    await rejectsWith(reset.resetPassword({ otpId: c.otpId, password: 'x', userTypeIds: AGENT }), 'not_found');
    await reset.resetPassword({ otpId: c.otpId, password: 'x', userTypeIds: CUSTOMER });
    assert.equal(state.users.get(20).password, 'hash(x)');
    await rejectsWith(reset.verifyCode({ otpId: 999, code: '1234', userTypeIds: AGENT }), 'not_found');
    await rejectsWith(reset.verifyCode({ otpId: undefined, code: '1234', userTypeIds: AGENT }), 'not_found');
  }

  // ── A flow's own accept rule (skipCodeCheck) still ends in the same single-use reset ──
  {
    const { reset, state } = makeWorld();
    const c = await reset.issueCode({ userId: 20 });
    await reset.verifyCode({ otpId: c.otpId, code: 'test', userTypeIds: CUSTOMER, skipCodeCheck: true });
    await rejectsWith(reset.verifyCode({ otpId: c.otpId, code: c.code, userTypeIds: CUSTOMER }), 'invalidated');
    await reset.resetPassword({ otpId: c.otpId, userId: 20, password: 'p', userTypeIds: CUSTOMER });
    assert.deepEqual(state.ended, [20]);
  }

  // ── If the sessions cannot be ended, the password is not changed and the reset stays open ──
  {
    const { reset, state } = makeWorld();
    const c = await reset.issueCode({ userId: 10 });
    await reset.verifyCode({ otpId: c.otpId, code: c.code, userTypeIds: AGENT });
    state.failSessionsEnd = true;
    await assert.rejects(reset.resetPassword({ otpId: c.otpId, password: 'p', userTypeIds: AGENT }), /redis down/);
    assert.equal(state.users.get(10).password, 'old-agent');
    state.failSessionsEnd = false;
    await reset.resetPassword({ otpId: c.otpId, password: 'p', userTypeIds: AGENT });
    assert.equal(state.users.get(10).password, 'hash(p)');
  }

  // ── HTTP mapping keeps each API's statuses ──
  {
    const err = new PasswordResetError('incorrect', { attemptsRemaining: 2 });
    assert.equal(toHttpError(err).statusCode, 401);
    assert.equal(toHttpError(err, { incorrect: 400 }).statusCode, 400);
    assert.deepEqual(toHttpError(err).details, { attemptsRemaining: 2 });
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
    await store.consumeCode(5, '0421', now, now);
    assert.deepEqual(updates[1].where, { id: 5, OTP: '0421', expirtAt: { [Op.gte]: now } });
    assert.equal(updates[1].values.OTP, null, 'the code is used up');
    assert.equal(await store.consumeCode(5, '', now, now), false, 'an empty code never matches');
    await store.consumeVerifiedReset(5, 10, now, { id: 'tx' });
    assert.deepEqual(updates[2].where, {
      id: 5, userId: 10, verifiedAtForgetCase: true, expirtAt: { [Op.gte]: now },
    });
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

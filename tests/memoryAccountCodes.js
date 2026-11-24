'use strict';

/**
 * An in-memory account-code world for tests: users, otpVerifications rows, sessions ended and
 * a clock, with a store that has the same conditional-update semantics as
 * services/shared/passwordReset.js sequelizeResetStore. Used by tests/passwordReset.test.js (the
 * lifecycle) and tests/accountCodeCallSites.test.js (the customer, agent and driver flows).
 */

const assert = require('assert/strict');
const { newOtpCode } = require('../services/shared/otpCode');
const {
  CODE_ISSUE_LIMIT,
  PasswordResetError,
  createPasswordReset,
} = require('../services/shared/passwordReset');

const live = (at) => (date) => Boolean(date) && new Date(date) >= at;

/**
 * The flows accept the test code 5678 by their own rule in some places; a real code of 5678
 * would make "test code refused" and "real code accepted" indistinguishable, so tests never
 * issue it (and never guess it as a wrong code).
 */
const TEST_CODE = '5678';
function issueableCode(now) {
  let otp;
  do { otp = newOtpCode(now); } while (otp.code === TEST_CODE);
  return otp;
}

/**
 * @param {object} [options]
 * @param {Array<{ id: number, userTypeId: number, password?: string, deletedAt?: Date }>} [options.users]
 */
function makeAccountCodeWorld({ users } = {}) {
  const state = {
    users: new Map((users || [
      { id: 10, userTypeId: 4, password: 'old-agent' },
      { id: 20, userTypeId: 2, password: 'old-customer' },
      { id: 30, userTypeId: 4, password: 'old-other-agent' },
      { id: 40, userTypeId: 3, password: 'old-driver' },
    ]).map((u) => [u.id, { ...u }])),
    codes: [],
    nextId: 1,
    ended: [],
    clock: new Date('2026-11-24T10:00:00Z'),
    failSessionsEnd: false,
  };
  const byId = (id) => state.codes.find((r) => String(r.id) === String(id));
  const copy = (r) => (r ? { ...r } : null);

  const store = {
    async findCode(otpId) {
      return copy(byId(otpId));
    },
    async findAccountCode(userId) {
      return copy(state.codes.filter((r) => r.userId === Number(userId)).sort((a, b) => a.id - b.id)[0]);
    },
    async findAccount(userId, types) {
      const u = state.users.get(Number(userId));
      return u && !u.deletedAt && types.includes(u.userTypeId) ? { id: u.id } : null;
    },
    async writeFreshCode(userId, columns) {
      const rows = state.codes.filter((r) => r.userId === userId).sort((a, b) => a.id - b.id);
      if (!rows.length) {
        const row = { id: state.nextId++, userId, ...columns };
        state.codes.push(row);
        return { otpId: row.id, created: true };
      }
      Object.assign(rows[0], columns);
      rows.slice(1).forEach((r) => Object.assign(r, { OTP: null, verifiedAtForgetCase: false, resetExpiresAt: null }));
      return { otpId: rows[0].id, created: false };
    },
    async reserveAttempt(otpId, at, max) {
      const r = byId(otpId);
      if (!r || !r.OTP || r.failedAttempts >= max || !live(at)(r.expirtAt)) return false;
      r.failedAttempts += 1;
      return true;
    },
    async consumeCode(otpId, code, at, outcome) {
      const r = byId(otpId);
      if (!code || !r || r.OTP !== code || !live(at)(r.expirtAt)) return false;
      Object.assign(r, { OTP: null, failedAttempts: 0, ...outcome });
      return true;
    },
    async consumeWithoutCheck(otpId, outcome) {
      const r = byId(otpId);
      if (!r) return false;
      Object.assign(r, { OTP: null, failedAttempts: 0, ...outcome });
      return true;
    },
    async invalidateCode(otpId, max) {
      const r = byId(otpId);
      if (r && r.failedAttempts >= max) r.OTP = null;
    },
    async consumeVerifiedReset(otpId, userId, at, tx) {
      assert.ok(tx && tx.pending, 'consumed inside the transaction');
      const r = byId(otpId);
      if (!r || r.userId !== userId || r.verifiedAtForgetCase !== true || !live(at)(r.resetExpiresAt)) return false;
      tx.pending.push(() => Object.assign(r, { verifiedAtForgetCase: false, resetExpiresAt: null }));
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
    newCode: issueableCode,
  });
  const advance = (ms) => { state.clock = new Date(state.clock.getTime() + ms); };
  const row = (otpId) => byId(otpId);
  const codeOf = (otpId) => byId(otpId).OTP;
  return { state, store, reset, advance, row, codeOf, issued };
}

/** A different 4-digit code (never the test code). */
function wrongCode(code) {
  let n = Number(code);
  let wrong;
  do { n = (n + 1) % 10000; wrong = String(n).padStart(4, '0'); } while (wrong === TEST_CODE || wrong === code);
  return wrong;
}

module.exports = { makeAccountCodeWorld, wrongCode };

'use strict';

/**
 * The emailed account code (services/shared/passwordReset.js, services/shared/otpCode.js), the
 * lifecycle shared by the customer, agent and driver APIs for sign-up verification and
 * password reset:
 *  - the account is the code owner, never a client-supplied userId (one that is sent is checked);
 *  - a code is digits only, must be live (issued, unused, unexpired) and is single use;
 *  - a used, invalidated or superseded code (OTP NULL) never verifies anything, in any flow;
 *  - every code is bound to its purpose (sign-up or password reset) and verifies only for it;
 *  - wrong guesses are limited per code, codes per account per hour and per day, and wrong
 *    guesses add up per account into an escalating wait for the next code (O-12-R2-1);
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
  CODE_PURPOSES,
  generateOtpCode,
  freshCodeColumns,
  normalizeSubmittedCode,
} = require('../services/shared/otpCode');
const {
  MAX_FAILED_ATTEMPTS,
  PASSWORD_RESET_WINDOW_MS,
  CODE_ISSUE_LIMITS,
  FAILED_GUESS_BACKOFF,
  lockoutBackoffSec,
  lockoutBackoffSchedule,
  PasswordResetError,
  codeState,
  resetState,
  resetInProgress,
  RESET_IN_PROGRESS_MS,
  toId,
  sequelizeResetStore,
  redisCodeLimiter,
  toHttpError,
} = require('../services/shared/passwordReset');
const { makeAccountCodeWorld: makeWorld, memoryCodeLimiter, wrongCode } = require('./memoryAccountCodes');

const AGENT = [4];
const SIGNUP = CODE_PURPOSES.SIGNUP;
const RESET = CODE_PURPOSES.PASSWORD_RESET;
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
    freshCodeColumns({ code: '0042', requestedAt: new Date(0), expiresAt: new Date(1) }, RESET),
    {
      OTP: '0042', codePurpose: 'password_reset', reqAt: new Date(0), expirtAt: new Date(1), failedAttempts: 0,
      verifiedAtForgetCase: false, resetExpiresAt: null,
    },
    'a new code clears the earlier lifecycle and records its purpose'
  );
  assert.equal(freshCodeColumns({ code: '1' }, SIGNUP).codePurpose, 'signup');
  for (const bad of [undefined, null, '', 'login', 'SIGNUP']) {
    assert.throws(() => freshCodeColumns({ code: '1' }, bad), /unknown code purpose/, 'no code without a purpose');
  }

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
  const liveReset = { OTP: '1234', codePurpose: RESET, expirtAt: later, failedAttempts: 0 };
  assert.equal(codeState(liveReset, at, MAX_FAILED_ATTEMPTS, RESET), 'live');
  assert.equal(codeState(liveReset, at, MAX_FAILED_ATTEMPTS, SIGNUP), 'other_purpose');
  assert.equal(codeState({ ...liveReset, codePurpose: null }, at, MAX_FAILED_ATTEMPTS, RESET), 'other_purpose',
    'a code issued before purposes were recorded verifies nothing');
  assert.equal(codeState({ ...liveReset, failedAttempts: MAX_FAILED_ATTEMPTS }, at, MAX_FAILED_ATTEMPTS, SIGNUP),
    'other_purpose', 'another flow learns nothing about the code');
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
    const { otpId, code, created } = await reset.issueCode({ userId: 10, purpose: RESET });
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
    const mine = await reset.issueCode({ userId: 30, purpose: RESET });
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
    const a = await reset.issueCode({ userId: 10, purpose: RESET });
    await rejectsWith(reset.resetPassword({ otpId: a.otpId, password: 'x', userTypeIds: AGENT }), 'not_verified');
    advance(OTP_TTL_MS + 1);
    await rejectsWith(reset.verifyResetCode({ otpId: a.otpId, code: a.code, userTypeIds: AGENT }), 'expired');

    const b = await reset.issueCode({ userId: 10, purpose: RESET });
    await reset.verifyResetCode({ otpId: b.otpId, code: b.code, userTypeIds: AGENT });
    // The reset window is its own duration, longer than the code's, and not the code expiry.
    assert.ok(PASSWORD_RESET_WINDOW_MS > OTP_TTL_MS);
    advance(OTP_TTL_MS + 1);
    assert.equal(state.codes[0].OTP, null);
    advance(PASSWORD_RESET_WINDOW_MS - OTP_TTL_MS - 2);
    await reset.resetPassword({ otpId: b.otpId, password: 'in-time', userTypeIds: AGENT });
    assert.equal(state.users.get(10).password, 'hash(in-time)');

    const c = await reset.issueCode({ userId: 10, purpose: RESET });
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
    const { otpId, code } = await reset.issueCode({ userId: 10, purpose: RESET });
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
    const again = await reset.issueCode({ userId: 10, purpose: RESET });
    assert.equal(again.otpId, otpId, 'one row per account');
    await reset.verifyResetCode({ otpId, code: again.code, userTypeIds: AGENT });
  }

  // ── Parallel guesses cannot exceed the limit ──
  {
    const { reset, state } = makeWorld();
    const { otpId, code } = await reset.issueCode({ userId: 10, purpose: RESET });
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
    const a = await reset.issueCode({ userId: 10, purpose: RESET });
    await reset.verifyResetCode({ otpId: a.otpId, code: a.code, userTypeIds: AGENT });
    await reset.issueCode({ userId: 10, purpose: RESET });
    await rejectsWith(reset.resetPassword({ otpId: a.otpId, password: 'x', userTypeIds: AGENT }), 'not_verified');
  }

  // ── Codes per account per hour and per day ──
  {
    const { reset, advance } = makeWorld();
    const HOUR = 60 * 60 * 1000;
    assert.deepEqual(
      Object.values(CODE_ISSUE_LIMITS).map(({ windowSec, max }) => [windowSec, max]),
      [[3600, 5], [86400, 10]],
      'the documented caps (swagger.yaml)'
    );
    for (let i = 0; i < CODE_ISSUE_LIMITS.hourly.max; i += 1) await reset.issueCode({ userId: 10, purpose: RESET });
    await assert.rejects(reset.issueCode({ userId: 10, purpose: RESET }), (err) =>
      err.reason === 'throttled' && err.details.retryAfterSeconds === 3600);
    await reset.issueCode({ userId: 30, purpose: RESET }); // other accounts are unaffected
    advance(HOUR);
    for (let i = 0; i < CODE_ISSUE_LIMITS.daily.max - CODE_ISSUE_LIMITS.hourly.max; i += 1) {
      await reset.issueCode({ userId: 10, purpose: RESET });
    }
    // The daily cap holds although the hour has room again; refusals are not counted.
    advance(HOUR);
    await assert.rejects(reset.issueCode({ userId: 10, purpose: RESET }), (err) =>
      err.reason === 'throttled' && err.details.retryAfterSeconds === 22 * 3600);
    await rejectsWith(reset.reserveIssue({ userId: 10 }), 'throttled');
    advance(22 * HOUR);
    await reset.issueCode({ userId: 10, purpose: RESET });
  }

  // ── Wrong guesses add up per account: escalating wait for the next code ──
  {
    assert.deepEqual(lockoutBackoffSchedule(), [0, 900, 1800, 3600, 7200, 14400, 28800, 57600, 86400]);
    assert.equal(lockoutBackoffSec(1), 0, 'one locked code: a new code at once');
    assert.equal(lockoutBackoffSec(2), FAILED_GUESS_BACKOFF.baseSec);
    assert.equal(lockoutBackoffSec(50), FAILED_GUESS_BACKOFF.maxSec);

    const { reset, advance, limiter } = makeWorld();
    const lock = async (purpose = RESET) => {
      const c = await reset.issueCode({ userId: 10, purpose });
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
        await assert.rejects(purpose === RESET
          ? reset.verifyResetCode({ otpId: c.otpId, code: wrongCode(c.code), userTypeIds: AGENT })
          : reset.verifySignupCode({ otpId: c.otpId, code: wrongCode(c.code), userTypeIds: AGENT }));
      }
    };
    await lock();
    await lock(SIGNUP); // both purposes count against the same account
    assert.equal(limiter.failedGuesses(10), 2 * MAX_FAILED_ATTEMPTS);
    await assert.rejects(reset.issueCode({ userId: 10, purpose: RESET }), (err) =>
      err.reason === 'throttled' && err.details.retryAfterSeconds === 900);
    await rejectsWith(reset.issueResendCode({ userId: 10 }), 'throttled');
    await rejectsWith(reset.reserveIssue({ userId: 10 }), 'throttled');
    await reset.issueCode({ userId: 30, purpose: RESET }); // other accounts are unaffected
    advance(900 * 1000);
    await lock();
    await rejectsWith(reset.issueCode({ userId: 10, purpose: RESET }), 'throttled');
    advance(1800 * 1000 - 1);
    await rejectsWith(reset.issueCode({ userId: 10, purpose: RESET }), 'throttled');
    advance(1);
    // A correct code clears the tally: the owner is not delayed by earlier guesses.
    const ok = await reset.issueCode({ userId: 10, purpose: RESET });
    await assert.rejects(reset.verifyResetCode({ otpId: ok.otpId, code: wrongCode(ok.code), userTypeIds: AGENT }));
    await reset.verifyResetCode({ otpId: ok.otpId, code: ok.code, userTypeIds: AGENT });
    assert.equal(limiter.failedGuesses(10), 0);
    await reset.issueCode({ userId: 10, purpose: RESET });
  }

  // ── Guesses spread over codes replaced early count the same as a locked code ──
  {
    const { reset, limiter } = makeWorld();
    for (let round = 0; round < 3; round += 1) {
      const c = await reset.issueCode({ userId: 10, purpose: RESET });
      for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) {
        await rejectsWith(reset.verifyResetCode({ otpId: c.otpId, code: wrongCode(c.code), userTypeIds: AGENT }),
          'incorrect');
      }
    }
    assert.equal(limiter.failedGuesses(10), 3 * (MAX_FAILED_ATTEMPTS - 1));
    await rejectsWith(reset.issueCode({ userId: 10, purpose: RESET }), 'throttled');
  }

  // ── The tally is forgotten FAILED_GUESS_BACKOFF.memorySec after the last wrong guess ──
  {
    const { reset, advance, limiter } = makeWorld();
    for (let n = 0; n < 2; n += 1) {
      const c = await reset.issueCode({ userId: 10, purpose: RESET });
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
        await assert.rejects(reset.verifyResetCode({ otpId: c.otpId, code: wrongCode(c.code), userTypeIds: AGENT }));
      }
    }
    advance(FAILED_GUESS_BACKOFF.memorySec * 1000);
    assert.equal(FAILED_GUESS_BACKOFF.memorySec, 30 * 24 * 3600);
    const c = await reset.issueCode({ userId: 10, purpose: RESET });
    await assert.rejects(reset.verifyResetCode({ otpId: c.otpId, code: wrongCode(c.code), userTypeIds: AGENT }));
    assert.equal(limiter.failedGuesses(10), 1, 'counting starts again');
  }

  // ── Long-horizon bound: an attacker who always guesses wrong at one account ──
  {
    const { reset, advance, state } = makeWorld();
    const DAY = 24 * 60 * 60 * 1000;
    const start = state.clock.getTime();
    let guesses = 0;
    const guessesBy = {};
    while (state.clock.getTime() - start < 30 * DAY) {
      let c;
      try {
        c = await reset.issueCode({ userId: 10, purpose: RESET });
      } catch (err) {
        assert.equal(err.reason, 'throttled');
        advance(err.details.retryAfterSeconds * 1000);
        continue;
      }
      const day = Math.floor((state.clock.getTime() - start) / DAY) + 1;
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
        await assert.rejects(reset.verifyResetCode({ otpId: c.otpId, code: wrongCode(c.code), userTypeIds: AGENT }));
        guesses += 1;
        guessesBy[day] = (guessesBy[day] || 0) + 1;
      }
    }
    assert.ok(guessesBy[1] <= 40, `day 1: ${guessesBy[1]} guesses`);
    for (let day = 3; day <= 30; day += 1) assert.ok((guessesBy[day] || 0) <= 5, `day ${day}: ${guessesBy[day]}`);
    assert.ok(guesses <= 185, `30 days: ${guesses} guesses`);
    assert.ok(guesses / 10 ** OTP_CODE_LENGTH < 0.02, 'under 2% of the code space in 30 days');
  }

  // ── Account types: a flow only finds codes of the accounts it serves ──
  {
    const { reset, state } = makeWorld();
    const c = await reset.issueCode({ userId: 20, purpose: RESET }); // a customer
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
    const c = await reset.issueCode({ userId: 20, purpose: RESET });
    await reset.verifyResetCode({ otpId: c.otpId, code: 'test', userTypeIds: CUSTOMER, skipCodeCheck: true });
    await rejectsWith(reset.verifyResetCode({ otpId: c.otpId, code: c.code, userTypeIds: CUSTOMER }), 'invalidated');
    await reset.resetPassword({ otpId: c.otpId, userId: 20, password: 'p', userTypeIds: CUSTOMER });
    assert.deepEqual(state.ended, [20]);
  }

  // ── If the sessions cannot be ended, the password is not changed and the reset stays open ──
  {
    const { reset, state } = makeWorld();
    const c = await reset.issueCode({ userId: 10, purpose: RESET });
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
    const a = await reset.issueCode({ userId: 20, purpose: SIGNUP });
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
    const b = await reset.issueCode({ userId: 20, purpose: SIGNUP });
    assert.deepEqual(await reset.verifySignupCode({ otpId: b.otpId, code: b.code, userTypeIds: CUSTOMER }),
      { otpId: b.otpId, userId: 20 });
    const c = await reset.issueCode({ userId: 40, purpose: SIGNUP });
    assert.deepEqual(await reset.verifySignupCode({ userId: '40', code: c.code, userTypeIds: DRIVER }),
      { otpId: c.otpId, userId: 40 });
    await rejectsWith(reset.verifySignupCode({ code: c.code, userTypeIds: DRIVER }), 'not_found');
    await rejectsWith(reset.verifySignupCode({ userId: { $gt: 0 }, code: c.code, userTypeIds: DRIVER }), 'not_found');
    // A flow only finds its own kind of account, by otpId or by userId.
    const d = await reset.issueCode({ userId: 10, purpose: SIGNUP });
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
    const used = await reset.issueCode({ userId: 20, purpose: RESET });
    await reset.verifyResetCode({ otpId: used.otpId, code: used.code, userTypeIds: CUSTOMER });
    await reset.resetPassword({ otpId: used.otpId, password: 'p', userTypeIds: CUSTOMER });
    assert.equal(row(used.otpId).OTP, null);
    await attempts(used.otpId, 20, CUSTOMER);
    // Locked by wrong guesses.
    const locked = await reset.issueCode({ userId: 10, purpose: SIGNUP });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await assert.rejects(reset.verifySignupCode({ otpId: locked.otpId, code: wrongCode(locked.code), userTypeIds: AGENT }));
    }
    assert.equal(row(locked.otpId).OTP, null);
    await attempts(locked.otpId, 10, AGENT);
    await rejectsWith(reset.verifySignupCode({ otpId: locked.otpId, code: locked.code, userTypeIds: AGENT }), 'locked');
    // Superseded: an account's extra row is emptied by a new code.
    state.codes.push({ id: 99, userId: 40, OTP: '1111', expirtAt: new Date(state.clock.getTime() + 1000), failedAttempts: 0 });
    state.codes.push({ id: 100, userId: 40, OTP: '2222', expirtAt: new Date(state.clock.getTime() + 1000), failedAttempts: 0 });
    const fresh = await reset.issueCode({ userId: 40, purpose: SIGNUP });
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
    const c = await reset.issueCode({ userId: 20, purpose: SIGNUP });
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
    const c = await reset.issueCode({ userId: 20, purpose: SIGNUP });
    const results = await Promise.all([1, 2].map(() =>
      reset.verifySignupCode({ otpId: c.otpId, code: c.code, userTypeIds: CUSTOMER }).then(() => 'ok', (e) => e.reason)));
    assert.deepEqual(results.sort(), ['invalidated', 'ok']);
  }

  // ── Sign-up re-issue counts against the same per-account code limit ──
  {
    const { reset } = makeWorld();
    for (let i = 0; i < CODE_ISSUE_LIMITS.hourly.max - 1; i += 1) await reset.reserveIssue({ userId: 20 });
    await reset.issueCode({ userId: 20, purpose: SIGNUP });
    await rejectsWith(reset.reserveIssue({ userId: 20 }), 'throttled');
    await rejectsWith(reset.issueCode({ userId: 20, purpose: SIGNUP }), 'throttled');
  }

  // ── O-12-R2-1: a code verifies only for its own purpose ──
  {
    const { reset, row, state, limiter } = makeWorld();
    // A password-reset code never verifies a sign-up (that would sign the account in).
    const r = await reset.issueCode({ userId: 20, purpose: RESET });
    await rejectsWith(reset.verifySignupCode({ otpId: r.otpId, code: r.code, userTypeIds: CUSTOMER }), 'invalidated');
    await rejectsWith(reset.verifySignupCode({ userId: 20, code: r.code, userTypeIds: CUSTOMER }), 'invalidated');
    await rejectsWith(
      reset.verifySignupCode({ otpId: r.otpId, code: 'test', userTypeIds: CUSTOMER, skipCodeCheck: true }),
      'invalidated',
      'not by a flow\'s own accept rule either'
    );
    assert.equal(row(r.otpId).OTP, r.code, 'the reset code is untouched');
    assert.equal(row(r.otpId).failedAttempts, 0, 'and no attempt of it was used');
    assert.equal(limiter.failedGuesses(20), 0);
    await reset.verifyResetCode({ otpId: r.otpId, code: r.code, userTypeIds: CUSTOMER });

    // A sign-up code never opens a password reset.
    const s1 = await reset.issueCode({ userId: 20, purpose: SIGNUP });
    await rejectsWith(reset.verifyResetCode({ otpId: s1.otpId, code: s1.code, userTypeIds: CUSTOMER }), 'invalidated');
    await rejectsWith(
      reset.verifyResetCode({ otpId: s1.otpId, code: 'test', userTypeIds: CUSTOMER, skipCodeCheck: true }),
      'invalidated'
    );
    await rejectsWith(reset.resetPassword({ otpId: s1.otpId, password: 'x', userTypeIds: CUSTOMER }), 'not_verified');
    assert.equal(row(s1.otpId).OTP, s1.code);
    await reset.verifySignupCode({ otpId: s1.otpId, code: s1.code, userTypeIds: CUSTOMER });

    // The purpose is checked atomically with the code: a code replaced by one of the other
    // purpose between the check and the update is not used.
    const raced = await reset.issueCode({ userId: 10, purpose: SIGNUP });
    row(raced.otpId).codePurpose = RESET; // what a concurrent forget-password request leaves
    await rejectsWith(reset.verifySignupCode({ otpId: raced.otpId, code: raced.code, userTypeIds: AGENT }), 'invalidated');

    // A row with no purpose (issued before purposes were recorded) verifies nothing.
    state.codes.push({ id: 200, userId: 30, OTP: '4321', expirtAt: new Date(state.clock.getTime() + 1000), failedAttempts: 0 });
    await rejectsWith(reset.verifySignupCode({ otpId: 200, code: '4321', userTypeIds: AGENT }), 'invalidated');
    await rejectsWith(reset.verifyResetCode({ otpId: 200, code: '4321', userTypeIds: AGENT }), 'invalidated');
  }

  // ── Sign-up codes only for accounts not verified yet; a resend keeps the code's purpose ──
  {
    const { reset, row, state } = makeWorld();
    state.users.get(20).verifiedAt = new Date('2026-01-01T00:00:00Z');
    await rejectsWith(reset.issueCode({ userId: 20, purpose: SIGNUP }), 'already_verified');
    await rejectsWith(reset.issueCode({ userId: 999, purpose: SIGNUP }), 'not_found');
    await assert.rejects(reset.issueCode({ userId: 20 }), /unknown code purpose/);
    // Verified: a resend is always a password reset, whatever the row held before.
    state.codes.push({ id: 300, userId: 20, OTP: null, codePurpose: SIGNUP, failedAttempts: 0 });
    const verifiedResend = await reset.issueResendCode({ userId: 20 });
    assert.equal(verifiedResend.otpId, 300);
    assert.equal(verifiedResend.purpose, RESET);
    assert.equal(row(300).codePurpose, RESET);
    await rejectsWith(reset.verifySignupCode({ otpId: 300, code: verifiedResend.code, userTypeIds: CUSTOMER }), 'invalidated');
    await reset.verifyResetCode({ otpId: 300, code: verifiedResend.code, userTypeIds: CUSTOMER });
    // Not verified: a sign-up code is resent as a sign-up code; a reset requested within
    // RESET_IN_PROGRESS_MS is resent as a reset code.
    const signup = await reset.issueCode({ userId: 40, purpose: SIGNUP });
    assert.equal((await reset.issueResendCode({ userId: 40 })).purpose, SIGNUP);
    await reset.issueCode({ userId: 40, purpose: RESET });
    const resetResend = await reset.issueResendCode({ userId: '40' });
    assert.equal(resetResend.purpose, RESET, 'an unverified account resetting its password');
    assert.equal(resetResend.otpId, signup.otpId);
    // Not verified, no purpose recorded (or no row): the sign-up being verified.
    assert.equal((await reset.issueResendCode({ userId: 30 })).purpose, SIGNUP);
    row(signup.otpId).codePurpose = null;
    assert.equal((await reset.issueResendCode({ userId: 40 })).purpose, SIGNUP);
    await rejectsWith(reset.issueResendCode({ userId: 999 }), 'not_found');
  }

  // ── O-12-R3-1: an unverified account's reset ends, so its sign-up can still be verified ──
  {
    // resetInProgress: a reset code requested within RESET_IN_PROGRESS_MS, or a verified reset
    // still open; nothing else.
    const at = new Date('2026-11-24T10:00:00Z');
    const ago = (ms) => new Date(at.getTime() - ms);
    assert.equal(resetInProgress(null, at), false);
    assert.equal(resetInProgress({ codePurpose: SIGNUP, reqAt: at }, at), false);
    assert.equal(resetInProgress({ codePurpose: null, reqAt: at }, at), false, 'a completed reset');
    assert.equal(resetInProgress({ codePurpose: RESET, reqAt: ago(RESET_IN_PROGRESS_MS - 1) }, at), true);
    assert.equal(resetInProgress({ codePurpose: RESET, reqAt: ago(RESET_IN_PROGRESS_MS) }, at), false);
    assert.equal(resetInProgress({ codePurpose: RESET, reqAt: null }, at), false, 'no request time: not held');
    assert.equal(resetInProgress({
      codePurpose: RESET, reqAt: ago(RESET_IN_PROGRESS_MS), verifiedAtForgetCase: true, resetExpiresAt: new Date(at.getTime() + 1),
    }, at), true, 'a verified reset still open');
    assert.equal(resetInProgress({
      codePurpose: RESET, reqAt: ago(RESET_IN_PROGRESS_MS), verifiedAtForgetCase: true, resetExpiresAt: ago(1),
    }, at), false, 'a verified reset that expired');
  }
  {
    // Completed: forget → reset → (login sends it to email verification) → resend → sign-up
    // verify succeeds, at once (the reset purpose ended with the reset, not with time).
    const { reset, row, state } = makeWorld();
    assert.ok(!state.users.get(20).verifiedAt, 'customer 20 never verified its sign-up');
    await reset.issueCode({ userId: 20, purpose: SIGNUP });
    const forgot = await reset.issueCode({ userId: 20, purpose: RESET });
    await reset.verifyResetCode({ otpId: forgot.otpId, code: forgot.code, userTypeIds: CUSTOMER });
    await reset.resetPassword({ otpId: forgot.otpId, password: 'n3w', userTypeIds: CUSTOMER });
    assert.equal(row(forgot.otpId).codePurpose, null, 'the reset purpose ended with the reset');
    const resend = await reset.issueResendCode({ userId: 20 });
    assert.equal(resend.purpose, SIGNUP);
    assert.equal(row(resend.otpId).codePurpose, SIGNUP);
    assert.deepEqual(
      await reset.verifySignupCode({ otpId: resend.otpId, code: resend.code, userTypeIds: CUSTOMER }),
      { otpId: forgot.otpId, userId: 20 }
    );
  }
  {
    // Abandoned before the code was verified: resends within RESET_IN_PROGRESS_MS stay reset
    // codes (the forgot-password screen after the code expired); after it, a sign-up code.
    const { reset, advance } = makeWorld();
    await reset.issueCode({ userId: 40, purpose: RESET });
    advance(OTP_TTL_MS + 1);
    const onResetScreen = await reset.issueResendCode({ userId: 40 });
    assert.equal(onResetScreen.purpose, RESET);
    advance(RESET_IN_PROGRESS_MS - 1);
    assert.equal((await reset.issueResendCode({ userId: 40 })).purpose, RESET, 'held from the last request');
    advance(RESET_IN_PROGRESS_MS);
    const later = await reset.issueResendCode({ userId: 40 });
    assert.equal(later.purpose, SIGNUP);
    await reset.verifySignupCode({ userId: 40, code: later.code, userTypeIds: DRIVER });
  }
  {
    // Abandoned after the code was verified: held while the verified reset is open, then a
    // sign-up code.
    const { reset, advance } = makeWorld();
    const forgot = await reset.issueCode({ userId: 10, purpose: RESET });
    advance(30 * 1000);
    await reset.verifyResetCode({ otpId: forgot.otpId, code: forgot.code, userTypeIds: AGENT });
    advance(RESET_IN_PROGRESS_MS - 10 * 1000); // past the request hold, the reset still open
    const open = await reset.issueResendCode({ userId: 10 });
    assert.equal(open.purpose, RESET);
    advance(RESET_IN_PROGRESS_MS);
    const abandoned = await reset.issueResendCode({ userId: 10 });
    assert.equal(abandoned.purpose, SIGNUP);
    await reset.verifySignupCode({ otpId: abandoned.otpId, code: abandoned.code, userTypeIds: AGENT });
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

  // ── Redis limiter: one atomic script per issue, with every limit's keys and values ──
  // (The script itself runs against a real Redis in tests/accountCodeLimits.redis.test.js.)
  {
    const calls = [];
    let reply = 0;
    const redis = {
      async eval(script, opts) { calls.push({ script, ...opts }); return reply; },
      async del(key) { calls.push({ del: key }); return 1; },
    };
    const limiter = redisCodeLimiter(redis);
    const now = new Date('2026-11-24T10:00:00Z');
    await limiter.assertIssueAllowed(7, now);
    assert.deepEqual(calls[0].keys, ['rl:otp:issue:u:7', 'rl:otp:issue:day:u:7', 'rl:otp:fail:u:7'],
      'the hourly counter keeps its key');
    assert.deepEqual(calls[0].arguments, [
      String(now.getTime()), '2', '3600000', '5', '86400000', '10', String(MAX_FAILED_ATTEMPTS),
      ...lockoutBackoffSchedule().map((sec) => String(sec * 1000)),
    ]);
    reply = 1500;
    await assert.rejects(limiter.assertIssueAllowed(7, now),
      (e) => e.reason === 'throttled' && e.details.retryAfterSeconds === 2);
    await limiter.recordFailedGuess(7, now);
    assert.deepEqual(calls[2].keys, ['rl:otp:fail:u:7']);
    assert.deepEqual(calls[2].arguments, [String(now.getTime()), String(30 * 24 * 3600 * 1000)]);
    await limiter.clearFailedGuesses(7);
    assert.deepEqual(calls[3], { del: 'rl:otp:fail:u:7' });
    const down = redisCodeLimiter({ async eval() { throw new Error('ECONNREFUSED'); } });
    await assert.rejects(down.assertIssueAllowed(7, now), /ECONNREFUSED/, 'fails closed');
    await assert.rejects(down.recordFailedGuess(7, now), /ECONNREFUSED/, 'fails closed');
    assert.equal(typeof memoryCodeLimiter, 'function');
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
    await store.reserveAttempt(5, RESET, now, 5);
    assert.deepEqual(updates[0].where, {
      id: 5, codePurpose: RESET, OTP: { [Op.not]: null }, failedAttempts: { [Op.lt]: 5 }, expirtAt: { [Op.gte]: now },
    });
    assert.deepEqual(updates[0].values, { failedAttempts: { literal: 'failedAttempts + 1' } });
    await store.consumeCode(5, '0421', RESET, now, { verifiedAtForgetCase: true, resetExpiresAt: now });
    assert.deepEqual(updates[1].where, { id: 5, codePurpose: RESET, OTP: '0421', expirtAt: { [Op.gte]: now } });
    assert.deepEqual(updates[1].values, {
      OTP: null, failedAttempts: 0, verifiedAtForgetCase: true, resetExpiresAt: now,
    }, 'the code is used up; expirtAt is left as the code expiry');
    assert.equal(await store.consumeCode(5, '', RESET, now, {}), false, 'an empty code never matches');
    await store.consumeVerifiedReset(5, 10, now, { id: 'tx' });
    assert.deepEqual(updates[2].where, {
      id: 5, userId: 10, verifiedAtForgetCase: true, resetExpiresAt: { [Op.gte]: now },
    });
    assert.deepEqual(
      updates[2].values,
      { verifiedAtForgetCase: false, resetExpiresAt: null, codePurpose: null },
      'the reset purpose ends with the reset, in the same conditional update'
    );
    await store.setPassword(10, 'h', { id: 'tx' });
    assert.deepEqual(updates[3], { values: { password: 'h' }, where: { id: 10 }, users: true });
    await store.consumeWithoutCheck(5, SIGNUP, { verifiedAtForgetCase: false, resetExpiresAt: null });
    assert.deepEqual(updates[4].where, { id: 5, codePurpose: SIGNUP }, 'a flow\'s accept rule keeps the purpose');
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

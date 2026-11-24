'use strict';

/**
 * The emailed account code: the single implementation of its lifecycle for customers
 * (/customer), shop agents (/agent) and drivers (/driver), used by sign-up verification and by
 * password reset. No other module reads or writes a code's state (otpVerifications.OTP,
 * codePurpose, expirtAt, failedAttempts, verifiedAtForgetCase, resetExpiresAt);
 * tests/accountCodeCallSites.test.js fails if one does.
 *
 *   1. issueCode        — forget-password request, sign-up re-issue: a new code on the
 *      issueResendCode    account's otpVerifications row (services/shared/otpCode.js), which ends
 *                         whatever the earlier code had reached (wrong guesses, a verified reset).
 *                         Every code is issued for one PURPOSE (otpCode.CODE_PURPOSES, stored in
 *                         codePurpose): sign-up verification, only ever for an account that is not
 *                         verified yet, or password reset. A resend issues a reset code to a
 *                         verified account (it can only be resetting its password) and to an
 *                         unverified one only while a reset is in progress (resetInProgress:
 *                         RESET_IN_PROGRESS_MS after its last code was requested, or while its
 *                         verified reset is open); otherwise the unverified account is verifying
 *                         its sign-up and gets a sign-up code.
 *                         Issuing is bounded per account (CODE_ISSUE_LIMITS, FAILED_GUESS_BACKOFF),
 *                         so the per-code guess limit cannot be reset at will by asking for new
 *                         codes; see "Guessing bound" below.
 *   2. verifySignupCode — sign-up: the code proves the account's email; it is consumed.
 *      verifyResetCode  — password reset: the code is consumed and opens a reset that must be
 *                         completed within PASSWORD_RESET_WINDOW_MS (resetExpiresAt).
 *                         Both: the account is the code row's OWNER (otpVerifications.userId); a
 *                         userId the client sends must name it. The code must be the row's live
 *                         code (issued, unused, unexpired) OF THE FLOW'S PURPOSE, compared as a
 *                         string. Every guess first reserves one of MAX_FAILED_ATTEMPTS; at the
 *                         limit the code is invalidated. All checks are conditional UPDATEs (the
 *                         purpose is in their WHERE clause), so concurrent requests cannot exceed
 *                         the limit, use one code twice or use a code for the other purpose.
 *   3. resetPassword    — sets the password of the verified code's owner, never of a client
 *                         userId (one that is sent must name the owner). The verified reset is
 *                         consumed and the reset purpose ends with it (codePurpose = NULL, in the
 *                         same conditional UPDATE), and every session of the account ends
 *                         (utils/appSession.endAllAppSessions) in the same transaction.
 *
 * A used, invalidated or superseded code is OTP = NULL; codeState() classifies such a row as
 * 'invalidated', so it can never match anything.
 *
 * Each flow passes the account types it serves, so a code of another kind of account is not
 * found through it. Dependencies are injected (store, sessions, limiter, clock) so the
 * lifecycle is unit-tested without a database (tests/passwordReset.test.js);
 * defaultPasswordReset() wires the real ones.
 */

const {
  CODE_PURPOSES,
  isCodePurpose,
  newOtpCode,
  freshCodeColumns,
  normalizeSubmittedCode,
} = require('./otpCode');

/*
 * Guessing bound — every limit on guessing one account's 4-digit code (10^4 values), in one
 * place. Documented in swagger.yaml next to each code endpoint.
 *
 *  - MAX_FAILED_ATTEMPTS wrong guesses per code; then the code is invalidated.
 *  - CODE_ISSUE_LIMITS: new codes per account per hour and per day.
 *  - FAILED_GUESS_BACKOFF: wrong guesses are also tallied per account across codes. Every
 *    MAX_FAILED_ATTEMPTS of them count as one lockout (a locked code, or the same number of wrong
 *    guesses spread over codes replaced early); after the first `freeLockouts`, each further
 *    lockout makes the account wait before its next code: baseSec, doubling, at most maxSec.
 *    The tally is cleared by a correct code and forgotten memorySec after the last wrong guess.
 *
 * A normal user (a typo or two, a resend, even one locked code) never meets these. An attacker
 * guessing at one account gets at most 40 guesses in the first day and 5 a day after that (the
 * 24-hour backoff), so 185 guesses (under 2% of the codes) in 30 days, where the hourly cap alone
 * allowed 25 an hour (about 50% in 11 days). tests/passwordReset.test.js replays that attacker
 * against these values.
 */

/** Wrong guesses allowed per code; the code is invalidated when they are used up. */
const MAX_FAILED_ATTEMPTS = 5;

/**
 * Time to choose and confirm the new password once the reset code is verified. A product
 * duration of its own, sized for typing a password twice; it does not depend on how long an
 * emailed code can be entered (otpCode.OTP_TTL_MS). Documented in swagger.yaml.
 */
const PASSWORD_RESET_WINDOW_MS = 10 * 60 * 1000;

/**
 * How long after its last code was requested (otpVerifications.reqAt) a password reset of an
 * account that is not verified yet still counts as in progress, so that a resend gives it
 * another reset code (the forgot-password screen's resend after the 1-minute code expired).
 * After that, or once the reset is completed, the account is verifying its sign-up again
 * (login sends it to email verification) and a resend gives it a sign-up code. Without this
 * bound, an abandoned reset would leave every later resend a reset code that sign-up
 * verification refuses. A verified reset in progress is also bounded by its own
 * resetExpiresAt. Documented in swagger.yaml with the resend endpoints.
 */
const RESET_IN_PROGRESS_MS = PASSWORD_RESET_WINDOW_MS;

/**
 * New codes (forget-password requests, resends, sign-up re-issues) per account per window; each
 * window starts with its first code. `key` is the Redis counter's prefix.
 * Trade-off: the requests are unauthenticated, so anyone who knows an account's email or id can
 * use the allowance up (or run up the backoff with wrong guesses) and delay that account's reset
 * until the window or backoff ends (and each new code ends a reset in progress). Without these,
 * wrong-guess limits per code would not bound guessing at all. Documented in swagger.yaml.
 */
const CODE_ISSUE_LIMITS = Object.freeze({
  hourly: Object.freeze({ key: 'rl:otp:issue:u', windowSec: 60 * 60, max: 5 }),
  daily: Object.freeze({ key: 'rl:otp:issue:day:u', windowSec: 24 * 60 * 60, max: 10 }),
});

/** Escalating wait before the next code once wrong guesses add up (see "Guessing bound"). */
const FAILED_GUESS_BACKOFF = Object.freeze({
  key: 'rl:otp:fail:u',
  freeLockouts: 1,
  baseSec: 15 * 60,
  maxSec: 24 * 60 * 60,
  memorySec: 30 * 24 * 60 * 60,
});

/** Wait (seconds) before the next code after `lockouts` lockouts. */
function lockoutBackoffSec(lockouts, policy = FAILED_GUESS_BACKOFF) {
  if (lockouts <= policy.freeLockouts) return 0;
  return Math.min(policy.baseSec * 2 ** (lockouts - policy.freeLockouts - 1), policy.maxSec);
}

/** lockoutBackoffSec for 1, 2, … lockouts, up to the first that reaches maxSec (held after). */
function lockoutBackoffSchedule(policy = FAILED_GUESS_BACKOFF) {
  const schedule = [];
  for (let lockouts = 1; ; lockouts += 1) {
    const sec = lockoutBackoffSec(lockouts, policy);
    schedule.push(sec);
    if (sec >= policy.maxSec) return schedule;
  }
}

/** bcrypt cost used for account passwords throughout the app APIs. */
const PASSWORD_HASH_ROUNDS = 8;

/** Why a step was refused; `status` is the HTTP status unless a flow overrides it. */
const FAILURES = Object.freeze({
  not_found: { status: 404, message: 'Sorry, we could not fetch the data', hint: 'Please resend OTP to continue' },
  incorrect: { status: 401, message: 'You entered incorrect OTP Please enter correct OTP to continue' },
  expired: { status: 400, message: 'OTP has expired. Please request a new OTP to continue' },
  invalidated: { status: 400, message: 'This OTP is no longer valid. Please request a new OTP to continue' },
  locked: { status: 429, message: 'Too many incorrect attempts. Please request a new OTP to continue' },
  throttled: { status: 429, message: 'Too many OTP requests. Please wait and try again' },
  already_verified: { status: 409, message: 'This account is already verified' },
  not_verified: { status: 401, message: 'OTP not verified yet', hint: 'Please verify OTP first' },
  reset_expired: { status: 400, message: 'Your password reset has expired. Please request a new OTP to continue' },
  user_mismatch: { status: 401, message: 'This OTP was not issued for this account' },
  password_required: { status: 400, message: 'Password is required' },
});

class PasswordResetError extends Error {
  /**
   * @param {keyof FAILURES} reason
   * @param {object} [data] extra response data (attemptsRemaining, retryAfterSeconds)
   */
  constructor(reason, data = null) {
    const failure = FAILURES[reason];
    if (!failure) throw new Error(`PasswordResetError: unknown reason ${reason}`);
    super(failure.message);
    this.name = 'PasswordResetError';
    this.reason = reason;
    this.status = failure.status;
    const details = { ...(failure.hint ? { message: failure.hint } : {}), ...(data || {}) };
    this.details = Object.keys(details).length ? details : null;
  }
}

const isPast = (date, now) => !date || new Date(date).getTime() < now.getTime();

/**
 * Where the row's code stands: missing | other_purpose | locked | invalidated | expired | live.
 * `purpose`: the flow's purpose; a code issued for another one (or for none) is other_purpose.
 */
function codeState(row, now, maxFailedAttempts = MAX_FAILED_ATTEMPTS, purpose = undefined) {
  if (!row) return 'missing';
  if (purpose !== undefined && row.codePurpose !== purpose) return 'other_purpose';
  if (Number(row.failedAttempts) >= maxFailedAttempts) return 'locked';
  if (!row.OTP) return 'invalidated';
  if (isPast(row.expirtAt, now)) return 'expired';
  return 'live';
}

/** Where the row's verified reset stands: missing | not_verified | reset_expired | ready. */
function resetState(row, now) {
  if (!row) return 'missing';
  if (row.verifiedAtForgetCase !== true && row.verifiedAtForgetCase !== 1) return 'not_verified';
  if (isPast(row.resetExpiresAt, now)) return 'reset_expired';
  return 'ready';
}

/**
 * Whether the row holds a password reset still in progress: its code was issued for a reset
 * and either requested less than RESET_IN_PROGRESS_MS ago or verified with the reset still open.
 * A completed reset has no purpose left (resetPassword clears it).
 */
function resetInProgress(row, now, holdMs = RESET_IN_PROGRESS_MS) {
  if (!row || row.codePurpose !== CODE_PURPOSES.PASSWORD_RESET) return false;
  if (resetState(row, now) === 'ready') return true;
  return Boolean(row.reqAt) && new Date(row.reqAt).getTime() + holdMs > now.getTime();
}

// A code of another purpose is, for this flow, no valid code (the apps' existing 400).
const CODE_FAILURE = {
  missing: 'not_found', other_purpose: 'invalidated', locked: 'locked', invalidated: 'invalidated', expired: 'expired',
};
const RESET_FAILURE = { missing: 'not_found', not_verified: 'not_verified', reset_expired: 'reset_expired' };

const isAbsent = (value) => value === undefined || value === null || value === '';

/** A row or account id as sent by a client (number or digit string), or null. */
function toId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) {
    const id = Number(value.trim());
    return id > 0 ? id : null;
  }
  return null;
}

/** What a verified code leaves on its row (besides OTP = NULL and failedAttempts = 0). */
const SIGNUP_VERIFIED = Object.freeze({ verifiedAtForgetCase: false, resetExpiresAt: null });
const resetOpened = (until) => ({ verifiedAtForgetCase: true, resetExpiresAt: until });

/**
 * @param {object} deps
 * @param {object} deps.store            persistence (sequelizeResetStore)
 * @param {function} deps.endAllSessions (userId, { transaction }) ends every session of the account
 * @param {object} deps.codeLimiter      per-account limits (redisCodeLimiter):
 *                                       assertIssueAllowed(userId, now) throws PasswordResetError('throttled'),
 *                                       recordFailedGuess(userId, now), clearFailedGuesses(userId)
 * @param {function} deps.hashPassword   (password) => hash
 * @param {function} [deps.now]          clock
 * @param {function} [deps.newCode]      (now) => { code, requestedAt, expiresAt } (otpCode.newOtpCode)
 */
function createPasswordReset({
  store,
  endAllSessions,
  codeLimiter,
  hashPassword,
  now = () => new Date(),
  newCode = newOtpCode,
  maxFailedAttempts = MAX_FAILED_ATTEMPTS,
}) {
  if (!store || !endAllSessions || !codeLimiter || !hashPassword) {
    throw new Error('createPasswordReset: store, endAllSessions, codeLimiter and hashPassword are required');
  }

  /**
   * The code row a request names, owned by an account of the given types.
   * By otpId when one is sent; otherwise, where the flow allows it (`byAccount`), the account's
   * own row named by userId. A userId that is sent must name the row's owner.
   */
  async function locateCode({ otpId, userId, userTypeIds, byAccount = false }) {
    let row = null;
    if (!isAbsent(otpId)) {
      const id = toId(otpId);
      const found = id ? await store.findCode(id) : null;
      if (found && found.userId && (await store.findAccount(found.userId, userTypeIds))) row = found;
    } else if (byAccount && !isAbsent(userId)) {
      const id = toId(userId);
      const account = id ? await store.findAccount(id, userTypeIds) : null;
      if (account) row = await store.findAccountCode(account.id);
    }
    if (!row) throw new PasswordResetError('not_found');
    if (!isAbsent(userId) && toId(userId) !== Number(row.userId)) {
      throw new PasswordResetError('user_mismatch');
    }
    return row;
  }

  /**
   * Check the submitted code against the row and use it up, leaving `outcome` on the row. The
   * code must have been issued for `purpose`.
   * `skipCodeCheck`: the flow accepted the code by its own rule; the row's code (of this
   * purpose) is used up all the same.
   */
  async function consume(row, code, purpose, outcome, skipCodeCheck) {
    const at = now();
    if (skipCodeCheck) {
      if (row.codePurpose !== purpose || !(await store.consumeWithoutCheck(row.id, purpose, outcome(at)))) {
        throw new PasswordResetError('invalidated');
      }
      return;
    }

    const state = codeState(row, at, maxFailedAttempts, purpose);
    if (state !== 'live') throw new PasswordResetError(CODE_FAILURE[state]);

    // Each guess uses one attempt before it is compared, so parallel guesses share the limit.
    if (!(await store.reserveAttempt(row.id, purpose, at, maxFailedAttempts))) {
      const current = codeState(await store.findCode(row.id), at, maxFailedAttempts, purpose);
      throw new PasswordResetError(CODE_FAILURE[current] || 'invalidated');
    }

    const ownerId = Number(row.userId);
    if (await store.consumeCode(row.id, normalizeSubmittedCode(code), purpose, at, outcome(at))) {
      // The owner proved the mailbox: earlier wrong guesses no longer delay new codes.
      await codeLimiter.clearFailedGuesses(ownerId);
      return;
    }

    // Not consumed: a wrong code, or the code ended meanwhile (used by a parallel request,
    // expired, replaced). The reserved attempt was a guess at this account either way.
    await codeLimiter.recordFailedGuess(ownerId, at);
    const after = await store.findCode(row.id);
    const afterState = codeState(after, at, maxFailedAttempts, purpose);
    if (afterState === 'locked') {
      await store.invalidateCode(row.id, maxFailedAttempts);
      throw new PasswordResetError('locked');
    }
    if (afterState !== 'live') throw new PasswordResetError(CODE_FAILURE[afterState]);
    throw new PasswordResetError('incorrect', {
      attemptsRemaining: maxFailedAttempts - Number(after.failedAttempts),
    });
  }

  /**
   * Count one new code against the account's limits, for flows that write the code themselves
   * (sign-up re-issue inside the account's own transaction, purpose CODE_PURPOSES.SIGNUP).
   */
  async function reserveIssue({ userId }) {
    if (!userId) throw new Error('reserveIssue: userId is required');
    await codeLimiter.assertIssueAllowed(userId, now());
  }

  /**
   * Issue a new code for the account, for `purpose` (otpCode.CODE_PURPOSES). A sign-up code is
   * only for an account that is not verified yet. The caller emails `code` to the account's
   * address.
   * @returns {Promise<{ otpId: number, code: string, created: boolean, purpose: string }>}
   */
  async function issueCode({ userId, purpose }) {
    if (!isCodePurpose(purpose)) throw new Error(`issueCode: unknown code purpose ${purpose}`);
    if (purpose === CODE_PURPOSES.SIGNUP) {
      const account = await store.findAccountStatus(userId);
      if (!account) throw new PasswordResetError('not_found');
      if (account.verifiedAt) throw new PasswordResetError('already_verified');
    }
    await reserveIssue({ userId });
    const otp = newCode(now());
    const { otpId, created } = await store.writeFreshCode(userId, freshCodeColumns(otp, purpose));
    return { otpId, code: otp.code, created, purpose };
  }

  /**
   * Resend: a new code for what the account is doing. A verified account can only be resetting
   * its password. An account not verified yet is resetting its password only while its reset
   * is in progress (resetInProgress); otherwise (a sign-up code, no purpose, no row, a reset
   * completed or abandoned) it is verifying its sign-up.
   * @returns {Promise<{ otpId: number, code: string, created: boolean, purpose: string }>}
   */
  async function issueResendCode({ userId }) {
    const account = await store.findAccountStatus(userId);
    if (!account) throw new PasswordResetError('not_found');
    let purpose = CODE_PURPOSES.PASSWORD_RESET;
    if (!account.verifiedAt) {
      const row = await store.findAccountCode(account.id);
      purpose = resetInProgress(row, now()) ? CODE_PURPOSES.PASSWORD_RESET : CODE_PURPOSES.SIGNUP;
    }
    return issueCode({ userId: account.id, purpose });
  }

  /**
   * Sign-up verification: the account whose code it is, once the code is accepted and used up.
   * @param {object} input
   * @param {*} [input.otpId]   the row the app was given; without it, the account's own row
   *                            named by userId (the driver app sends no otpId)
   * @param {*} [input.userId]  the account the client believes it verifies; checked, never used
   * @param {number[]} input.userTypeIds account types this flow serves
   * @param {boolean} [input.skipCodeCheck] the flow accepted the code by its own rule
   * @returns {Promise<{ otpId: number, userId: number }>}
   */
  async function verifySignupCode({ otpId, userId, code, userTypeIds, skipCodeCheck = false }) {
    const row = await locateCode({ otpId, userId, userTypeIds, byAccount: true });
    await consume(row, code, CODE_PURPOSES.SIGNUP, () => SIGNUP_VERIFIED, skipCodeCheck);
    return { otpId: row.id, userId: Number(row.userId) };
  }

  /**
   * Password reset: verify the emailed code and open the reset.
   * @param {object} input see verifySignupCode; the row is always named by otpId
   * @returns {Promise<{ otpId: number, userId: number }>}
   */
  async function verifyResetCode({ otpId, userId, code, userTypeIds, skipCodeCheck = false }) {
    const row = await locateCode({ otpId, userId, userTypeIds });
    await consume(
      row,
      code,
      CODE_PURPOSES.PASSWORD_RESET,
      (at) => resetOpened(new Date(at.getTime() + PASSWORD_RESET_WINDOW_MS)),
      skipCodeCheck
    );
    return { otpId: row.id, userId: Number(row.userId) };
  }

  /**
   * Set the new password of the verified code's owner and end all of the account's sessions.
   * @param {object} input
   * @param {*} [input.userId] the account the client believes it resets; checked, never used
   * @returns {Promise<{ userId: number }>}
   */
  async function resetPassword({ otpId, userId, password, userTypeIds }) {
    if (typeof password !== 'string' || password.length === 0) {
      throw new PasswordResetError('password_required');
    }
    const row = await locateCode({ otpId, userId, userTypeIds });
    const at = now();
    const state = resetState(row, at);
    if (state !== 'ready') throw new PasswordResetError(RESET_FAILURE[state]);

    const hash = await hashPassword(password);
    const ownerId = Number(row.userId);
    await store.transaction(async (transaction) => {
      if (!(await store.consumeVerifiedReset(row.id, ownerId, at, transaction))) {
        const current = await store.findCode(row.id, transaction);
        throw new PasswordResetError(RESET_FAILURE[resetState(current, at)] || 'not_verified');
      }
      if (!(await store.setPassword(ownerId, hash, transaction))) {
        throw new PasswordResetError('not_found');
      }
      // Inside the transaction: if the sessions cannot be ended, the password is not changed.
      await endAllSessions(ownerId, { transaction });
    });
    return { userId: ownerId };
  }

  return { reserveIssue, issueCode, issueResendCode, verifySignupCode, verifyResetCode, resetPassword };
}

/** Persistence on the otpVerifications and users tables (Sequelize, MySQL). */
function sequelizeResetStore({ sequelize, users, otpVerification }) {
  const { Op } = require('sequelize');
  const CODE_ATTRIBUTES = [
    'id', 'userId', 'OTP', 'codePurpose', 'reqAt', 'expirtAt', 'failedAttempts', 'verifiedAtForgetCase', 'resetExpiresAt',
  ];
  const USED_UP = { OTP: null, failedAttempts: 0 };
  const affected = (result) => Array.isArray(result) && result[0] > 0;
  const plain = (row) => (row ? row.get({ plain: true }) : null);

  return {
    async findCode(otpId, transaction) {
      return plain(await otpVerification.findByPk(otpId, { attributes: CODE_ATTRIBUTES, transaction }));
    },

    /** The account's code row: the lowest-id row, the one writeFreshCode keeps. */
    async findAccountCode(userId) {
      return plain(await otpVerification.findOne({
        where: { userId },
        attributes: CODE_ATTRIBUTES,
        order: [['id', 'ASC']],
      }));
    },

    /** Whether the account (of any type; the flows check theirs) exists and is verified. */
    async findAccountStatus(userId) {
      const account = await users.findOne({
        where: { id: userId, deletedAt: { [Op.is]: null } },
        attributes: ['id', 'verifiedAt'],
      });
      return account ? { id: account.id, verifiedAt: account.verifiedAt || null } : null;
    },

    async findAccount(userId, userTypeIds) {
      return users.findOne({
        where: { id: userId, userTypeId: { [Op.in]: userTypeIds }, deletedAt: { [Op.is]: null } },
        attributes: ['id'],
      });
    },

    /** One live code per account: the lowest-id row holds it, any other row is emptied. */
    async writeFreshCode(userId, columns) {
      return sequelize.transaction(async (transaction) => {
        const rows = await otpVerification.findAll({
          where: { userId },
          attributes: ['id'],
          order: [['id', 'ASC']],
          lock: transaction.LOCK.UPDATE,
          transaction,
        });
        if (rows.length === 0) {
          const created = await otpVerification.create({ ...columns, userId }, { transaction });
          return { otpId: created.id, created: true };
        }
        const [kept, ...others] = rows;
        await otpVerification.update(columns, { where: { id: kept.id }, transaction });
        if (others.length) {
          await otpVerification.update(
            { OTP: null, codePurpose: null, verifiedAtForgetCase: false, resetExpiresAt: null },
            { where: { id: others.map((r) => r.id) }, transaction }
          );
        }
        return { otpId: kept.id, created: false };
      });
    },

    async reserveAttempt(otpId, purpose, now, maxFailedAttempts) {
      return affected(await otpVerification.update(
        { failedAttempts: sequelize.literal('failedAttempts + 1') },
        {
          where: {
            id: otpId,
            codePurpose: purpose,
            OTP: { [Op.not]: null },
            failedAttempts: { [Op.lt]: maxFailedAttempts },
            expirtAt: { [Op.gte]: now },
          },
        }
      ));
    },

    async consumeCode(otpId, code, purpose, now, outcome) {
      if (!code) return false;
      return affected(await otpVerification.update(
        { ...USED_UP, ...outcome },
        { where: { id: otpId, codePurpose: purpose, OTP: code, expirtAt: { [Op.gte]: now } } }
      ));
    },

    async consumeWithoutCheck(otpId, purpose, outcome) {
      return affected(await otpVerification.update(
        { ...USED_UP, ...outcome },
        { where: { id: otpId, codePurpose: purpose } }
      ));
    },

    async invalidateCode(otpId, maxFailedAttempts) {
      await otpVerification.update(
        { OTP: null },
        { where: { id: otpId, failedAttempts: { [Op.gte]: maxFailedAttempts } } }
      );
    },

    /** The verified reset is used up and the reset purpose ends with it. */
    async consumeVerifiedReset(otpId, userId, now, transaction) {
      return affected(await otpVerification.update(
        { verifiedAtForgetCase: false, resetExpiresAt: null, codePurpose: null },
        {
          where: { id: otpId, userId, verifiedAtForgetCase: true, resetExpiresAt: { [Op.gte]: now } },
          transaction,
        }
      ));
    },

    async setPassword(userId, hash, transaction) {
      return affected(await users.update({ password: hash }, { where: { id: userId }, transaction }));
    },

    transaction(fn) {
      return sequelize.transaction(fn);
    },
  };
}

/*
 * Issue check, atomic in Redis (one script, so concurrent requests cannot both take the last
 * code): refused while any issue window is full or the failed-guess backoff runs; otherwise
 * every window counts the code (a window starts with its first code). Refusals do not count.
 *   KEYS    issue-window counters…, failed-guess tally (hash: n = wrong guesses, at = last, ms)
 *   ARGV    now (ms), number of windows, (window ms, max) per window, guesses per lockout,
 *           backoff ms for 1, 2, … lockouts (the last is held after)
 *   returns 0 when the code may be issued, else the wait in ms
 */
const ISSUE_SCRIPT = `
local now = tonumber(ARGV[1])
local windows = tonumber(ARGV[2])
local wait = 0
for i = 1, windows do
  local windowMs = tonumber(ARGV[1 + 2 * i])
  local max = tonumber(ARGV[2 + 2 * i])
  if tonumber(redis.call('GET', KEYS[i]) or '0') >= max then
    local ttl = redis.call('PTTL', KEYS[i])
    if ttl < 0 then ttl = windowMs end
    if ttl > wait then wait = ttl end
  end
end
local tally = KEYS[windows + 1]
local perLockout = tonumber(ARGV[3 + 2 * windows])
local lockouts = math.floor(tonumber(redis.call('HGET', tally, 'n') or '0') / perLockout)
if lockouts > 0 then
  local first = 4 + 2 * windows
  local index = math.min(first + lockouts - 1, #ARGV)
  local untilMs = tonumber(redis.call('HGET', tally, 'at') or '0') + tonumber(ARGV[index])
  if untilMs - now > wait then wait = untilMs - now end
end
if wait > 0 then return wait end
for i = 1, windows do
  if redis.call('INCR', KEYS[i]) == 1 then
    redis.call('PEXPIRE', KEYS[i], ARGV[1 + 2 * i])
  end
end
return 0
`;

/** One wrong guess on the account's tally; it is forgotten memory ms after the last one. */
const FAILED_GUESS_SCRIPT = `
redis.call('HINCRBY', KEYS[1], 'n', 1)
redis.call('HSET', KEYS[1], 'at', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

/**
 * CODE_ISSUE_LIMITS and FAILED_GUESS_BACKOFF per account, kept in Redis. Fails closed: when
 * Redis cannot count, no code is issued and no guess is answered (Redis also holds every app
 * session, so sign-in is down in that case anyway).
 */
function redisCodeLimiter(redis, {
  limits = CODE_ISSUE_LIMITS,
  backoff = FAILED_GUESS_BACKOFF,
  maxFailedAttempts = MAX_FAILED_ATTEMPTS,
} = {}) {
  const windows = Object.values(limits);
  const tallyKey = (userId) => `${backoff.key}:${userId}`;
  const schedule = lockoutBackoffSchedule(backoff).map((sec) => String(sec * 1000));
  return {
    async assertIssueAllowed(userId, now) {
      const waitMs = Number(await redis.eval(ISSUE_SCRIPT, {
        keys: [...windows.map((w) => `${w.key}:${userId}`), tallyKey(userId)],
        arguments: [
          String(now.getTime()),
          String(windows.length),
          ...windows.flatMap((w) => [String(w.windowSec * 1000), String(w.max)]),
          String(maxFailedAttempts),
          ...schedule,
        ],
      }));
      if (waitMs > 0) {
        throw new PasswordResetError('throttled', { retryAfterSeconds: Math.ceil(waitMs / 1000) });
      }
    },
    async recordFailedGuess(userId, now) {
      await redis.eval(FAILED_GUESS_SCRIPT, {
        keys: [tallyKey(userId)],
        arguments: [String(now.getTime()), String(backoff.memorySec * 1000)],
      });
    },
    async clearFailedGuesses(userId) {
      await redis.del(tallyKey(userId));
    },
  };
}

let defaultInstance = null;

/** The lifecycle on the real database, Redis and session store. */
function defaultPasswordReset() {
  if (!defaultInstance) {
    const bcrypt = require('bcryptjs');
    const db = require('../../models');
    const redis = require('../../redis/redis');
    const { endAllAppSessions } = require('../../utils/appSession');
    defaultInstance = createPasswordReset({
      store: sequelizeResetStore({ sequelize: db.sequelize, users: db.users, otpVerification: db.otpVerification }),
      endAllSessions: endAllAppSessions,
      codeLimiter: redisCodeLimiter(redis),
      hashPassword: (password) => bcrypt.hash(password, PASSWORD_HASH_ROUNDS),
    });
  }
  return defaultInstance;
}

/**
 * The HTTP error for a refused step. Flows keep the status and wording their apps already
 * handle for a failure through `statusByReason` / `messageByReason` (e.g. the customer API
 * answers a wrong code with 400).
 */
function toHttpError(err, statusByReason = {}, messageByReason = {}) {
  if (!(err instanceof PasswordResetError)) return err;
  const { UniversalHttpError } = require('../../middlewares/universalErrorHandler');
  return new UniversalHttpError(
    messageByReason[err.reason] || err.message,
    statusByReason[err.reason] || err.status,
    err.details
  );
}

module.exports = {
  MAX_FAILED_ATTEMPTS,
  PASSWORD_RESET_WINDOW_MS,
  RESET_IN_PROGRESS_MS,
  CODE_ISSUE_LIMITS,
  FAILED_GUESS_BACKOFF,
  lockoutBackoffSec,
  lockoutBackoffSchedule,
  PASSWORD_HASH_ROUNDS,
  FAILURES,
  PasswordResetError,
  codeState,
  resetState,
  resetInProgress,
  toId,
  createPasswordReset,
  sequelizeResetStore,
  redisCodeLimiter,
  defaultPasswordReset,
  toHttpError,
};

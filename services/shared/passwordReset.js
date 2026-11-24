'use strict';

/**
 * The emailed account code: the single implementation of its lifecycle for customers
 * (/customer), shop agents (/agent) and drivers (/driver), used by sign-up verification and by
 * password reset. No other module reads or writes a code's state (otpVerifications.OTP,
 * expirtAt, failedAttempts, verifiedAtForgetCase, resetExpiresAt); tests/accountCodeCallSites.test.js
 * fails if one does.
 *
 *   1. issueCode        — forget-password request, resend, sign-up re-issue: a new code on the
 *                         account's otpVerifications row (services/shared/otpCode.js), which ends
 *                         whatever the earlier code had reached (wrong guesses, a verified reset).
 *                         At most CODE_ISSUE_LIMIT codes per account per window, so the per-code
 *                         guess limit cannot be reset at will by asking for new codes.
 *   2. verifySignupCode — sign-up: the code proves the account's email; it is consumed.
 *      verifyResetCode  — password reset: the code is consumed and opens a reset that must be
 *                         completed within PASSWORD_RESET_WINDOW_MS (resetExpiresAt).
 *                         Both: the account is the code row's OWNER (otpVerifications.userId); a
 *                         userId the client sends must name it. The code must be the row's live
 *                         code (issued, unused, unexpired), compared as a string. Every guess
 *                         first reserves one of MAX_FAILED_ATTEMPTS; at the limit the code is
 *                         invalidated. All checks are conditional UPDATEs, so concurrent requests
 *                         cannot exceed the limit or use one code twice.
 *   3. resetPassword    — sets the password of the verified code's owner, never of a client
 *                         userId (one that is sent must name the owner). The verified reset is
 *                         consumed, and every session of the account ends
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

const { newOtpCode, freshCodeColumns, normalizeSubmittedCode } = require('./otpCode');

/** Wrong guesses allowed per code; the code is invalidated when they are used up. */
const MAX_FAILED_ATTEMPTS = 5;

/**
 * Time to choose and confirm the new password once the reset code is verified. A product
 * duration of its own, sized for typing a password twice; it does not depend on how long an
 * emailed code can be entered (otpCode.OTP_TTL_MS). Documented in swagger.yaml.
 */
const PASSWORD_RESET_WINDOW_MS = 10 * 60 * 1000;

/**
 * New codes (forget-password requests, resends, sign-up re-issues) per account per window.
 * Trade-off: the requests are unauthenticated, so anyone who knows an account's email or id can
 * use the allowance up and delay that account's reset until the window ends (and each new code
 * ends a reset in progress). Without the cap, wrong-guess limits per code would not bound
 * guessing at all. Documented in swagger.yaml.
 */
const CODE_ISSUE_LIMIT = Object.freeze({ windowSec: 60 * 60, max: 5 });

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

/** Where the row's code stands: missing | locked | invalidated | expired | live. */
function codeState(row, now, maxFailedAttempts = MAX_FAILED_ATTEMPTS) {
  if (!row) return 'missing';
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

const CODE_FAILURE = { missing: 'not_found', locked: 'locked', invalidated: 'invalidated', expired: 'expired' };
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
 * @param {object} deps.issueLimiter     { assertAllowed(userId) } throws PasswordResetError('throttled')
 * @param {function} deps.hashPassword   (password) => hash
 * @param {function} [deps.now]          clock
 * @param {function} [deps.newCode]      (now) => { code, requestedAt, expiresAt } (otpCode.newOtpCode)
 */
function createPasswordReset({
  store,
  endAllSessions,
  issueLimiter,
  hashPassword,
  now = () => new Date(),
  newCode = newOtpCode,
  maxFailedAttempts = MAX_FAILED_ATTEMPTS,
}) {
  if (!store || !endAllSessions || !issueLimiter || !hashPassword) {
    throw new Error('createPasswordReset: store, endAllSessions, issueLimiter and hashPassword are required');
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
   * Check the submitted code against the row and use it up, leaving `outcome` on the row.
   * `skipCodeCheck`: the flow accepted the code by its own rule; the row's code is used up all
   * the same.
   */
  async function consume(row, code, outcome, skipCodeCheck) {
    const at = now();
    if (skipCodeCheck) {
      await store.consumeWithoutCheck(row.id, outcome(at));
      return;
    }

    const state = codeState(row, at, maxFailedAttempts);
    if (state !== 'live') throw new PasswordResetError(CODE_FAILURE[state]);

    // Each guess uses one attempt before it is compared, so parallel guesses share the limit.
    if (!(await store.reserveAttempt(row.id, at, maxFailedAttempts))) {
      const current = codeState(await store.findCode(row.id), at, maxFailedAttempts);
      throw new PasswordResetError(CODE_FAILURE[current] || 'invalidated');
    }

    if (await store.consumeCode(row.id, normalizeSubmittedCode(code), at, outcome(at))) return;

    // Not consumed: a wrong code, or the code ended meanwhile (used by a parallel request, expired).
    const after = await store.findCode(row.id);
    const afterState = codeState(after, at, maxFailedAttempts);
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
   * Count one new code against the account's limit, for flows that write the code themselves
   * (sign-up re-issue inside the account's own transaction).
   */
  async function reserveIssue({ userId }) {
    if (!userId) throw new Error('reserveIssue: userId is required');
    await issueLimiter.assertAllowed(userId);
  }

  /**
   * Issue a new code for the account. The caller emails `code` to the account's address.
   * @returns {Promise<{ otpId: number, code: string, created: boolean }>}
   */
  async function issueCode({ userId }) {
    await reserveIssue({ userId });
    const otp = newCode(now());
    const { otpId, created } = await store.writeFreshCode(userId, freshCodeColumns(otp));
    return { otpId, code: otp.code, created };
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
    await consume(row, code, () => SIGNUP_VERIFIED, skipCodeCheck);
    return { otpId: row.id, userId: Number(row.userId) };
  }

  /**
   * Password reset: verify the emailed code and open the reset.
   * @param {object} input see verifySignupCode; the row is always named by otpId
   * @returns {Promise<{ otpId: number, userId: number }>}
   */
  async function verifyResetCode({ otpId, userId, code, userTypeIds, skipCodeCheck = false }) {
    const row = await locateCode({ otpId, userId, userTypeIds });
    await consume(row, code, (at) => resetOpened(new Date(at.getTime() + PASSWORD_RESET_WINDOW_MS)), skipCodeCheck);
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

  return { reserveIssue, issueCode, verifySignupCode, verifyResetCode, resetPassword };
}

/** Persistence on the otpVerifications and users tables (Sequelize, MySQL). */
function sequelizeResetStore({ sequelize, users, otpVerification }) {
  const { Op } = require('sequelize');
  const CODE_ATTRIBUTES = [
    'id', 'userId', 'OTP', 'expirtAt', 'failedAttempts', 'verifiedAtForgetCase', 'resetExpiresAt',
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
            { OTP: null, verifiedAtForgetCase: false, resetExpiresAt: null },
            { where: { id: others.map((r) => r.id) }, transaction }
          );
        }
        return { otpId: kept.id, created: false };
      });
    },

    async reserveAttempt(otpId, now, maxFailedAttempts) {
      return affected(await otpVerification.update(
        { failedAttempts: sequelize.literal('failedAttempts + 1') },
        {
          where: {
            id: otpId,
            OTP: { [Op.not]: null },
            failedAttempts: { [Op.lt]: maxFailedAttempts },
            expirtAt: { [Op.gte]: now },
          },
        }
      ));
    },

    async consumeCode(otpId, code, now, outcome) {
      if (!code) return false;
      return affected(await otpVerification.update(
        { ...USED_UP, ...outcome },
        { where: { id: otpId, OTP: code, expirtAt: { [Op.gte]: now } } }
      ));
    },

    async consumeWithoutCheck(otpId, outcome) {
      return affected(await otpVerification.update({ ...USED_UP, ...outcome }, { where: { id: otpId } }));
    },

    async invalidateCode(otpId, maxFailedAttempts) {
      await otpVerification.update(
        { OTP: null },
        { where: { id: otpId, failedAttempts: { [Op.gte]: maxFailedAttempts } } }
      );
    },

    async consumeVerifiedReset(otpId, userId, now, transaction) {
      return affected(await otpVerification.update(
        { verifiedAtForgetCase: false, resetExpiresAt: null },
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

/**
 * CODE_ISSUE_LIMIT per account, counted in Redis. Fails closed: when Redis cannot count, no code
 * is issued (Redis also holds every app session, so sign-in is down in that case anyway).
 */
function redisIssueLimiter(redis, { windowSec, max } = CODE_ISSUE_LIMIT) {
  return {
    async assertAllowed(userId) {
      const key = `rl:otp:issue:u:${userId}`;
      // The window starts with the first code; INCR keeps the key's expiry.
      await redis.set(key, '0', { EX: windowSec, NX: true });
      const count = await redis.incr(key);
      if (count > max) {
        const ttl = await redis.ttl(key);
        throw new PasswordResetError('throttled', { retryAfterSeconds: ttl > 0 ? ttl : windowSec });
      }
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
      issueLimiter: redisIssueLimiter(redis),
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
  CODE_ISSUE_LIMIT,
  PASSWORD_HASH_ROUNDS,
  FAILURES,
  PasswordResetError,
  codeState,
  resetState,
  toId,
  createPasswordReset,
  sequelizeResetStore,
  redisIssueLimiter,
  defaultPasswordReset,
  toHttpError,
};

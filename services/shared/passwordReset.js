'use strict';

/**
 * Password reset by emailed code: the single implementation of the reset-code lifecycle for
 * customers (/customer), shop agents (/agent) and drivers (/driver).
 *
 *   1. issueCode    — forget-password request (and resend): a new code on the account's
 *                     otpVerifications row (services/shared/otpCode.js), which ends whatever the
 *                     earlier code had reached (wrong guesses, a verified reset). At most
 *                     CODE_ISSUE_LIMIT codes per account per window, so the per-code guess limit
 *                     cannot be reset at will by asking for new codes.
 *   2. verifyCode   — the code must be the row's live code, unexpired; it is consumed (single
 *                     use) and opens a reset that must be completed within RESET_GRANT_TTL_MS.
 *                     Every guess first reserves one of MAX_FAILED_ATTEMPTS; at the limit the code
 *                     is invalidated. All checks are conditional UPDATEs, so concurrent requests
 *                     cannot exceed the limit or use one code twice.
 *   3. resetPassword — sets the password of the code's OWNER (otpVerifications.userId), never of
 *                     a client-supplied userId: one that is sent must name the owner. The verified
 *                     reset is consumed, and every session of the account ends
 *                     (utils/appSession.endAllAppSessions) in the same transaction.
 *
 * The row is keyed by otpId (the client echoes the id it was given); each flow passes the
 * account types it serves, so a code of another kind of account is not found through it.
 *
 * Dependencies are injected (store, sessions, limiter, clock) so the lifecycle is unit-tested
 * without a database (tests/passwordReset.test.js); defaultPasswordReset() wires the real ones.
 */

const { OTP_TTL_MS, newOtpCode, freshCodeColumns, normalizeSubmittedCode } = require('./otpCode');

/** Wrong guesses allowed per code; the code is invalidated when they are used up. */
const MAX_FAILED_ATTEMPTS = 5;

/**
 * Time to choose the new password once the code is verified. It reuses the platform's code
 * lifetime (OTP_TTL_MS) rather than introducing a new product duration.
 */
const RESET_GRANT_TTL_MS = OTP_TTL_MS;

/** New codes (forget-password requests and resends) per account per window. */
const CODE_ISSUE_LIMIT = Object.freeze({ windowSec: 60 * 60, max: 5 });

/** bcrypt cost used for account passwords throughout the app APIs. */
const PASSWORD_HASH_ROUNDS = 8;

/** Why a reset step was refused; `status` is the HTTP status unless a flow overrides it. */
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
  if (!row.verifiedAtForgetCase) return 'not_verified';
  if (isPast(row.expirtAt, now)) return 'reset_expired';
  return 'ready';
}

const CODE_FAILURE = { missing: 'not_found', locked: 'locked', invalidated: 'invalidated', expired: 'expired' };
const RESET_FAILURE = { missing: 'not_found', not_verified: 'not_verified', reset_expired: 'reset_expired' };

const isAbsent = (value) => value === undefined || value === null || value === '';

/**
 * @param {object} deps
 * @param {object} deps.store            persistence (sequelizeResetStore)
 * @param {function} deps.endAllSessions (userId, { transaction }) ends every session of the account
 * @param {object} deps.issueLimiter     { assertAllowed(userId) } throws PasswordResetError('throttled')
 * @param {function} [deps.hashPassword] (password) => hash
 * @param {function} [deps.now]          clock
 */
function createPasswordReset({
  store,
  endAllSessions,
  issueLimiter,
  hashPassword,
  now = () => new Date(),
  maxFailedAttempts = MAX_FAILED_ATTEMPTS,
}) {
  if (!store || !endAllSessions || !issueLimiter || !hashPassword) {
    throw new Error('createPasswordReset: store, endAllSessions, issueLimiter and hashPassword are required');
  }

  /** The code row of an account of the given types, or null. */
  async function ownedCode(otpId, userTypeIds) {
    if (isAbsent(otpId)) return null;
    const row = await store.findCode(otpId);
    if (!row || !row.userId) return null;
    const account = await store.findAccount(row.userId, userTypeIds);
    return account ? row : null;
  }

  /**
   * Issue a new code for the account (forget-password request or resend). The caller emails
   * `code` to the account's address.
   * @returns {Promise<{ otpId: number, code: string, created: boolean }>}
   */
  async function issueCode({ userId }) {
    if (!userId) throw new Error('issueCode: userId is required');
    await issueLimiter.assertAllowed(userId);
    const otp = newOtpCode(now());
    const { otpId, created } = await store.writeFreshCode(userId, freshCodeColumns(otp));
    return { otpId, code: otp.code, created };
  }

  /**
   * Verify the emailed code and open the reset.
   * @param {object} input
   * @param {number[]} input.userTypeIds account types this flow serves
   * @param {boolean} [input.skipCodeCheck] the flow accepted the code by its own rule
   * @returns {Promise<{ otpId: number, userId: number }>}
   */
  async function verifyCode({ otpId, code, userTypeIds, skipCodeCheck = false }) {
    const row = await ownedCode(otpId, userTypeIds);
    if (!row) throw new PasswordResetError('not_found');
    const at = now();
    const resetUntil = new Date(at.getTime() + RESET_GRANT_TTL_MS);

    if (skipCodeCheck) {
      await store.markVerified(row.id, resetUntil);
      return { otpId: row.id, userId: row.userId };
    }

    const state = codeState(row, at, maxFailedAttempts);
    if (state !== 'live') throw new PasswordResetError(CODE_FAILURE[state]);

    // Each guess uses one attempt before it is compared, so parallel guesses share the limit.
    if (!(await store.reserveAttempt(row.id, at, maxFailedAttempts))) {
      const current = codeState(await store.findCode(row.id), at, maxFailedAttempts);
      throw new PasswordResetError(CODE_FAILURE[current] || 'invalidated');
    }

    if (await store.consumeCode(row.id, normalizeSubmittedCode(code), at, resetUntil)) {
      return { otpId: row.id, userId: row.userId };
    }

    const after = await store.findCode(row.id);
    const used = after ? Number(after.failedAttempts) : maxFailedAttempts;
    if (used >= maxFailedAttempts) {
      await store.invalidateCode(row.id, maxFailedAttempts);
      throw new PasswordResetError('locked');
    }
    throw new PasswordResetError('incorrect', { attemptsRemaining: maxFailedAttempts - used });
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
    const row = await ownedCode(otpId, userTypeIds);
    if (!row) throw new PasswordResetError('not_found');
    if (!isAbsent(userId) && String(userId) !== String(row.userId)) {
      throw new PasswordResetError('user_mismatch');
    }
    const at = now();
    const state = resetState(row, at);
    if (state !== 'ready') throw new PasswordResetError(RESET_FAILURE[state]);

    const hash = await hashPassword(password);
    const ownerId = row.userId;
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

  return { issueCode, verifyCode, resetPassword };
}

/** Persistence on the otpVerifications and users tables (Sequelize, MySQL). */
function sequelizeResetStore({ sequelize, users, otpVerification }) {
  const { Op } = require('sequelize');
  const CODE_ATTRIBUTES = ['id', 'userId', 'OTP', 'expirtAt', 'failedAttempts', 'verifiedAtForgetCase'];
  const affected = (result) => Array.isArray(result) && result[0] > 0;

  return {
    async findCode(otpId, transaction) {
      const row = await otpVerification.findByPk(otpId, { attributes: CODE_ATTRIBUTES, transaction });
      return row ? row.get({ plain: true }) : null;
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
            { OTP: null, expirtAt: null, verifiedAtForgetCase: false },
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

    async consumeCode(otpId, code, now, resetUntil) {
      if (!code) return false;
      return affected(await otpVerification.update(
        { OTP: null, failedAttempts: 0, verifiedAtForgetCase: true, expirtAt: resetUntil },
        { where: { id: otpId, OTP: code, expirtAt: { [Op.gte]: now } } }
      ));
    },

    async markVerified(otpId, resetUntil) {
      return affected(await otpVerification.update(
        { OTP: null, failedAttempts: 0, verifiedAtForgetCase: true, expirtAt: resetUntil },
        { where: { id: otpId } }
      ));
    },

    async invalidateCode(otpId, maxFailedAttempts) {
      await otpVerification.update(
        { OTP: null },
        { where: { id: otpId, failedAttempts: { [Op.gte]: maxFailedAttempts } } }
      );
    },

    async consumeVerifiedReset(otpId, userId, now, transaction) {
      return affected(await otpVerification.update(
        { verifiedAtForgetCase: false, expirtAt: null },
        {
          where: { id: otpId, userId, verifiedAtForgetCase: true, expirtAt: { [Op.gte]: now } },
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
 * The HTTP error for a refused step. Flows keep the status their apps already handle for a
 * failure through `statusByReason` (e.g. the customer API answers a wrong code with 400).
 */
function toHttpError(err, statusByReason = {}) {
  if (!(err instanceof PasswordResetError)) return err;
  const { UniversalHttpError } = require('../../middlewares/universalErrorHandler');
  return new UniversalHttpError(err.message, statusByReason[err.reason] || err.status, err.details);
}

module.exports = {
  MAX_FAILED_ATTEMPTS,
  RESET_GRANT_TTL_MS,
  CODE_ISSUE_LIMIT,
  PASSWORD_HASH_ROUNDS,
  FAILURES,
  PasswordResetError,
  codeState,
  resetState,
  createPasswordReset,
  sequelizeResetStore,
  redisIssueLimiter,
  defaultPasswordReset,
  toHttpError,
};

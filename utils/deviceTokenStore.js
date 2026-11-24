'use strict';

/**
 * Push tokens (deviceTokens table). A token belongs to one app install, so it may belong to
 * one user only: when a user signs in or the app reports its token, the same token is removed
 * from any other user (a phone that switched accounts must not get the old account's pushes).
 *
 * A token is only a push address. Sessions are keyed by the install's `deviceId`
 * (utils/appSession.js); rows record that `deviceId` so a rotated token replaces the install's
 * old one and signing out of an install removes exactly its tokens. Rows from app builds
 * without a deviceId have deviceId NULL and are removed by token (removeUserTokens).
 *
 * Each row also records the Firebase project that issued the token (`firebaseProjectId`,
 * reported by the client) so pushes go through that project (utils/fcmRouting.js). NULL means
 * not reported (older builds): such rows are routed legacy-first and the project that
 * accepts the token is recorded on first send. A later report without a project never
 * clears a recorded one.
 */

const { Op } = require('sequelize');
const { deviceToken } = require('../models');

/** Remove `tokenId` from every user except `userId`. */
async function detachFromOtherUsers(userId, tokenId) {
  if (!userId || !tokenId) return 0;
  return deviceToken.destroy({ where: { tokenId, userId: { [Op.ne]: userId } } });
}

/**
 * Save the app's current token for the user (idempotent): one row, active, and on no other user.
 * With the install's `deviceId`, the token replaces that install's earlier (rotated) token.
 * `firebaseProjectId`: the project that issued the token (validated by the caller), or null.
 * @returns {{ created: boolean }}
 */
async function saveCurrentToken(userId, tokenId, deviceId = null, firebaseProjectId = null) {
  await detachFromOtherUsers(userId, tokenId);
  if (deviceId) {
    await deviceToken.destroy({ where: { userId, deviceId, tokenId: { [Op.ne]: tokenId } } });
  }
  const existing = await deviceToken.findOne({ where: { userId, tokenId } });
  if (existing) {
    const changes = {};
    if (!existing.status) changes.status = true;
    if (deviceId && existing.deviceId !== deviceId) changes.deviceId = deviceId;
    if (firebaseProjectId && existing.firebaseProjectId !== firebaseProjectId) {
      changes.firebaseProjectId = firebaseProjectId;
    }
    if (Object.keys(changes).length) await existing.update(changes);
    return { created: false };
  }
  await deviceToken.create({ userId, tokenId, deviceId, firebaseProjectId, status: true });
  return { created: true };
}

/**
 * Sign-in: the user's devices become exactly this one (one push target per account, so
 * no duplicate notifications from stale installs), and the token leaves any other user.
 * No-op without a token.
 */
async function replaceUserToken(userId, tokenId, deviceId = null, firebaseProjectId = null) {
  if (!userId || !tokenId) return;
  await deviceToken.destroy({ where: { userId } });
  await detachFromOtherUsers(userId, tokenId);
  await deviceToken.create({ userId, tokenId, deviceId, firebaseProjectId, status: true });
}

/** Sign-out of an install: forget every token that install registered for this user. */
async function removeInstallTokens(userId, deviceId) {
  if (!userId || !deviceId) return 0;
  return deviceToken.destroy({ where: { userId, deviceId } });
}

/** Sign-out (legacy installs without a deviceId): forget the given token(s) for this user. */
async function removeUserTokens(userId, tokenIds) {
  const ids = (Array.isArray(tokenIds) ? tokenIds : [tokenIds]).filter(Boolean);
  if (!userId || ids.length === 0) return 0;
  return deviceToken.destroy({ where: { userId, tokenId: ids } });
}

/** Every session of the account ended (password reset): forget all of its push tokens. */
async function removeAllUserTokens(userId, { transaction } = {}) {
  if (!userId) return 0;
  return deviceToken.destroy({ where: { userId }, transaction });
}

module.exports = {
  detachFromOtherUsers,
  saveCurrentToken,
  replaceUserToken,
  removeInstallTokens,
  removeUserTokens,
  removeAllUserTokens,
};

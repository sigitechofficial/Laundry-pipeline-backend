'use strict';

/**
 * Push tokens (deviceTokens table). A token belongs to one app install, so it may belong to
 * one user only: when a user signs in or the app reports its token, the same token is removed
 * from any other user (a phone that switched accounts must not get the old account's pushes).
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
 * @returns {{ created: boolean }}
 */
async function saveCurrentToken(userId, tokenId) {
  await detachFromOtherUsers(userId, tokenId);
  const existing = await deviceToken.findOne({ where: { userId, tokenId } });
  if (existing) {
    if (!existing.status) await existing.update({ status: true });
    return { created: false };
  }
  await deviceToken.create({ userId, tokenId, status: true });
  return { created: true };
}

/**
 * Sign-in: the user's devices become exactly this one (one push target per account, so
 * no duplicate notifications from stale installs), and the token leaves any other user.
 * No-op without a token.
 */
async function replaceUserToken(userId, tokenId) {
  if (!userId || !tokenId) return;
  await deviceToken.destroy({ where: { userId } });
  await detachFromOtherUsers(userId, tokenId);
  await deviceToken.create({ userId, tokenId, status: true });
}

/** Sign-out: forget the given token(s) for this user. */
async function removeUserTokens(userId, tokenIds) {
  const ids = (Array.isArray(tokenIds) ? tokenIds : [tokenIds]).filter(Boolean);
  if (!userId || ids.length === 0) return 0;
  return deviceToken.destroy({ where: { userId, tokenId: ids } });
}

module.exports = { detachFromOtherUsers, saveCurrentToken, replaceUserToken, removeUserTokens };

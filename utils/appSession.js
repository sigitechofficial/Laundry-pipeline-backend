'use strict';

/**
 * App sign-in sessions (customer, shop owner, shop staff, driver): the single definition of
 * how a session is identified, opened, found and closed.
 *
 * IDENTITY — a session belongs to one app install, identified by `deviceId`: a random UUID the
 * app generates once and keeps for the life of the install. Redis hash appSessionKey(userId)
 * maps { [deviceId]: accessToken }, and the access token (JWT) carries the same `deviceId`
 * claim, so validators find the stored session from the token alone (sessionFieldOf). Several
 * installs of one account each have their own field; signing out of one revokes only that one.
 *
 * PUSH — the push (FCM) token is not part of the session. It is optional at sign-in (the iOS
 * simulator and devices whose Firebase fetch failed have none) and Firebase rotates it. It is
 * only a push address, kept in deviceTokens against the install (utils/deviceTokenStore.js) and
 * updated through POST /agent/deviceToken and POST /customer/deviceToken.
 *
 * LEGACY — DEPRECATED: app builds released before `deviceId` send only `dvToken` (their FCM
 * token at sign-in) and used it as the session id. They keep working exactly as before: the
 * session field and the JWT claim are that dvToken, and logout removes it. Every such
 * sign-in logs `[appSession] legacy dvToken session` so adoption can be tracked; once those
 * logs stop, delete the LEGACY branches here (resolveSessionIdentity, sessionFieldOf,
 * endAppSession). A sign-in with neither is refused: the server never invents an id.
 */

const jwt = require('jsonwebtoken');
const redisCli = require('../redis/redis');
const { appSessionKey } = require('./sessionKeys');
const { replaceUserToken, removeUserTokens, removeInstallTokens } = require('./deviceTokenStore');
const {
    DEVICE_ID_ERROR,
    normalizeDeviceId,
    resolveSessionIdentity,
    identityOfSession,
    sessionFieldOf,
} = require('./sessionIdentity');

/**
 * Sign in: make this install the account's push target (when it has a push token) and store
 * a session for it. `claims` are the account claims (id, email, role…); the session claim is
 * added here. Returns the access token.
 */
async function openAppSession({ userId, claims, identity }) {
    if (!userId) throw new Error('openAppSession: userId is required');
    if (!identity) throw new Error('openAppSession: identity is required');

    if (identity.pushToken) {
        await replaceUserToken(userId, identity.pushToken, identity.deviceId);
    }

    const accessToken = jwt.sign({ ...claims, ...identity.claims }, process.env.JWT_ACCESS_SECRET);
    await redisCli.hSet(appSessionKey(userId), { [identity.field]: accessToken });

    if (identity.legacy) {
        console.warn(`[appSession] legacy dvToken session user=${userId}`);
    }
    return accessToken;
}

/**
 * Sign out: revoke this install's session only and stop its pushes.
 * @param {object} user req.user (the verified session claims)
 * @param {{ currentPushToken?: string }} [options] LEGACY apps report the push token they
 *   hold now (it differs from the sign-in one after a rotation); installs with a deviceId
 *   have every token they reported stored against the install already.
 */
async function endAppSession(user, { currentPushToken } = {}) {
    const userId = user && user.id;
    const field = sessionFieldOf(user);
    if (!userId || !field) return;

    const deviceId = normalizeDeviceId(user.deviceId);
    if (deviceId) {
        await removeInstallTokens(userId, deviceId);
    } else {
        // LEGACY (deprecated): the session id was the sign-in push token.
        await removeUserTokens(userId, [user.dvToken, currentPushToken]);
    }
    await redisCli.hDel(appSessionKey(userId), field);
}

module.exports = {
    DEVICE_ID_ERROR,
    normalizeDeviceId,
    resolveSessionIdentity,
    identityOfSession,
    sessionFieldOf,
    openAppSession,
    endAppSession,
};

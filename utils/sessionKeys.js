'use strict';

/**
 * Redis session keys — the single definition. Each key is a hash of
 * { [deviceToken]: accessToken } for one account.
 *
 * - App accounts (customer, shop owner, shop staff, driver): validated by
 *   middlewares/accessToken.js and accessTokenOrGuest.js, socket auth.
 * - Admin panel accounts: validated by middlewares/adminValidateToken.js.
 *
 * Logouts previously deleted app sessions from the admin key, so signing out of the
 * customer or shop app never revoked the session. Build keys only through here.
 */
const appSessionKey = (userId) => `id-${userId}`;
const adminSessionKey = (adminId) => `tsh${adminId}`;

module.exports = { appSessionKey, adminSessionKey };

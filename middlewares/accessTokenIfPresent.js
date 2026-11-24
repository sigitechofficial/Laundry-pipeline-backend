'use strict';

/**
 * Session OPTIONAL: a request that carries an access token gets exactly the
 * validateAccessToken treatment (verified, session checked, req.user and the shop
 * context attached; an invalid or revoked token is refused with 403, never
 * silently downgraded to anonymous). A request with no token continues with no
 * req.user, and the handler decides what an anonymous caller may see.
 *
 * Only for routes that installed app builds call before a session exists (shop
 * registration); each use is listed in tests/agentRouteAuth.test.js with the
 * reason. Everything else uses validateAccessToken.
 */
const validateAccessToken = require('./accessToken');
const { sessionTokenOf } = require('../utils/sessionToken');

module.exports = function accessTokenIfPresent(req, res, next) {
    if (!sessionTokenOf(req)) return next();
    return validateAccessToken(req, res, next);
};

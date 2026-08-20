'use strict';

/**
 * Marks requests that have already passed through the authenticated admin
 * router. Controllers shared with shop-agent routes can use this server-owned
 * context without trusting a client-supplied header or query parameter.
 */
function markPlatformAdminRequest(req, _res, next) {
    req.isPlatformAdminRequest = true;
    next();
}

module.exports = {
    markPlatformAdminRequest,
};

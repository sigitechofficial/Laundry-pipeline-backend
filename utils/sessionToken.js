'use strict';

/**
 * Where an agent / customer app request carries its session access token: the
 * `accessToken` cookie, else the `accesstoken` or `x-access-token` header.
 * Shared by validateAccessToken (session required) and accessTokenIfPresent
 * (session optional) so both read the token from exactly the same places.
 * @param {import('express').Request} req
 * @returns {string|undefined} the token, or undefined when the request has none
 */
function sessionTokenOf(req) {
    const token =
        (req.cookies && req.cookies.accessToken) ||
        req.headers['accesstoken'] ||
        req.headers['x-access-token'];
    return token || undefined;
}

module.exports = { sessionTokenOf };

require("dotenv").config();
const { appSessionKey } = require('../utils/sessionKeys');
const { sessionFieldOf } = require('../utils/sessionIdentity');
const { verify } = require("jsonwebtoken");
const redisCli = require("../redis/redis");
const guestAuthService = require("../services/Customer/guestAuthService");
const { sendIfAccountBlocked } = require("./rejectBlockedAccount");

function extractToken(req) {
    let accessToken = req.cookies && req.cookies.accessToken;
    if (!accessToken) {
        accessToken =
            req.headers["accesstoken"] || req.headers["x-access-token"];
    }
    if (!accessToken && req.headers.authorization) {
        const authHeader = req.headers.authorization;
        if (
            typeof authHeader === "string" &&
            authHeader.startsWith("Bearer ")
        ) {
            accessToken = authHeader.slice(7).trim();
        }
    }
    return accessToken;
}

/**
 * Registered customer JWT + Redis (same as validateAccessToken) OR guest JWT + guest Redis.
 * Guests have no users.id; req.user is { guest: true, jti }.
 */
module.exports = async function validateAccessTokenOrGuest(req, res, next) {
    try {
        const accessToken = extractToken(req);
        if (!accessToken) {
            throw new Error("No token");
        }

        let decoded;
        try {
            decoded = verify(accessToken, process.env.JWT_ACCESS_SECRET);
        } catch (e) {
            const session =
                await guestAuthService.assertGuestSessionValid(accessToken);
            req.user = { guest: true, jti: session.jti };
            return next();
        }

        if (decoded.guest === true && decoded.jti) {
            await guestAuthService.assertGuestRedisSessionActive(decoded.jti);
            req.user = { guest: true, jti: decoded.jti };
            return next();
        }

        if (await sendIfAccountBlocked(decoded.id, res)) {
            return;
        }

        // The session of this app install (utils/appSession.js: deviceId, or a legacy dvToken).
        const sessionField = sessionFieldOf(decoded);
        const redisToken = await redisCli.hGetAll(appSessionKey(decoded.id));
        if (!sessionField || !redisToken || !redisToken[sessionField]) {
            throw new Error("Invalid Token");
        }

        const redis_Validate = verify(
            redisToken[sessionField],
            process.env.JWT_ACCESS_SECRET
        );

        req.user = redis_Validate;
        next();
    } catch (error) {
        return res.status(403).json({
            status: "0",
            message: "Access Denied",
            data: {},
            error: "You are not authorized to access it",
        });
    }
};

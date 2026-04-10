require("dotenv").config();
const guestAuthService = require("../services/Customer/guestAuthService");

/**
 * Same token sources as validateAccessToken, but for guest JWT + Redis session only.
 * Sets req.user = { guest: true, jti } — no users.id (guests are not in DB).
 */
module.exports = async function validateGuestAccessToken(req, res, next) {
    try {
        let accessToken = req.cookies && req.cookies.accessToken;
        if (!accessToken) {
            accessToken =
                req.headers["accesstoken"] || req.headers["x-access-token"];
        }
        if (!accessToken && req.headers.authorization) {
            const authHeader = req.headers.authorization;
            if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
                accessToken = authHeader.slice(7).trim();
            }
        }
        if (!accessToken) {
            throw new Error("No token");
        }

        const session = await guestAuthService.assertGuestSessionValid(
            accessToken
        );
        req.user = session;
        next();
    } catch (error) {
        return res.status(403).json({
            status: "0",
            message: "Access Denied",
            data: {},
            error: "Invalid or expired guest session",
        });
    }
};

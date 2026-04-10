require("dotenv").config();
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");
const redisCli = require("../../redis/redis");

const GUEST_REDIS_PREFIX = "guest-session:";

function guestJwtSecret() {
    const secret =
        process.env.JWT_GUEST_SECRET || process.env.JWT_ACCESS_SECRET;
    if (!secret) {
        throw new Error("JWT_ACCESS_SECRET (or JWT_GUEST_SECRET) must be set");
    }
    return secret;
}

function guestTtlSeconds() {
    const raw = process.env.GUEST_SESSION_DAYS;
    const days = raw !== undefined ? parseInt(raw, 10) : 7;
    const safeDays = Number.isFinite(days) && days > 0 ? days : 7;
    return safeDays * 24 * 60 * 60;
}

function guestUserStub() {
    return {
        id: "",
        firstName: "",
        lastName: "",
        email: "",
        userTypeId: 2,
        phoneNum: "",
        stripeCustomerId: "",
        dataValues: { joinedOn: null },
    };
}

/**
 * Issue a guest JWT and Redis session (no DB user).
 */
async function startGuestSession() {
    const jti = randomUUID();
    const ttlSec = guestTtlSeconds();
    const secret = guestJwtSecret();
    const accessToken = jwt.sign({ guest: true, jti }, secret, {
        expiresIn: ttlSec,
    });
    await redisCli.set(`${GUEST_REDIS_PREFIX}${jti}`, "1", { EX: ttlSec });
    return {
        accessToken,
        userData: guestUserStub(),
        expiresInSeconds: ttlSec,
    };
}

/**
 * Validate guest JWT and ensure Redis session exists.
 */
async function assertGuestSessionValid(token) {
    const secret = guestJwtSecret();
    const decoded = jwt.verify(token, secret);
    if (!decoded || decoded.guest !== true || !decoded.jti) {
        throw new Error("Invalid guest token");
    }
    await assertGuestRedisSessionActive(decoded.jti);
    return { jti: decoded.jti, guest: true };
}

/**
 * After JWT is verified elsewhere (same secret as guest), ensure Redis session exists.
 */
async function assertGuestRedisSessionActive(jti) {
    if (!jti) {
        throw new Error("Invalid guest session");
    }
    const key = `${GUEST_REDIS_PREFIX}${jti}`;
    const exists = await redisCli.exists(key);
    if (!exists) {
        throw new Error("Guest session expired or logged out");
    }
}

async function destroyGuestSession(jti) {
    await redisCli.del(`${GUEST_REDIS_PREFIX}${jti}`);
}

module.exports = {
    startGuestSession,
    assertGuestSessionValid,
    assertGuestRedisSessionActive,
    destroyGuestSession,
    guestUserStub,
    guestTtlSeconds,
};

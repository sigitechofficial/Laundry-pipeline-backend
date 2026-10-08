require("dotenv").config();
const redisCli = require("../redis/redis");
const { TooManyRequestsError } = require("./universalErrorHandler");

/**
 * Coupon brute-force protection (master plan §82): per customer and per IP.
 * Fails open when Redis is unavailable so checkout keeps working.
 */
const LIMITS = {
    validateCode: { windowSec: 10 * 60, max: 10, prefix: "rl:promo:code" },
    evaluate: { windowSec: 60, max: 60, prefix: "rl:promo:eval" },
};

async function hit(key, config) {
    const count = await redisCli.incr(key);
    if (count === 1) {
        await redisCli.expire(key, config.windowSec);
    }
    if (count > config.max) {
        let retryAfterSeconds = config.windowSec;
        try {
            const ttl = await redisCli.ttl(key);
            if (ttl > 0) retryAfterSeconds = ttl;
        } catch {
            /* keep default */
        }
        throw new TooManyRequestsError(
            "Too many attempts. Please wait and try again.",
            { retryAfterSeconds }
        );
    }
}

function createPromotionRateLimit(type) {
    const config = LIMITS[type];
    return async (req, res, next) => {
        try {
            const actors = [
                req.user?.id ? `u:${req.user.id}` : null,
                req.ip ? `ip:${req.ip}` : null,
            ].filter(Boolean);
            for (const actor of actors) {
                await hit(`${config.prefix}:${actor}`, config);
            }
            next();
        } catch (error) {
            if (error instanceof TooManyRequestsError) return next(error);
            console.warn(`[promotionRateLimit] Redis unavailable for ${type}:`, error.message);
            next();
        }
    };
}

module.exports = {
    promoCodeRateLimit: createPromotionRateLimit("validateCode"),
    promoEvaluateRateLimit: createPromotionRateLimit("evaluate"),
};

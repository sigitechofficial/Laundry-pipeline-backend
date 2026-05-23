require("dotenv").config();
const redisCli = require("../redis/redis");
const { TooManyRequestsError } = require("./universalErrorHandler");
const { getPostcodeActorId } = require("../utils/postcodeActor");

const LIMITS = {
    autocomplete: {
        windowSec: 60,
        max: 30,
        prefix: "rl:pc:auto",
    },
    validate: {
        windowSec: 60,
        max: 20,
        prefix: "rl:pc:validate",
    },
};

async function getRetryAfterSeconds(key) {
    try {
        const ttl = await redisCli.ttl(key);
        return ttl > 0 ? ttl : 60;
    } catch {
        return 60;
    }
}

async function assertRateLimit(actorId, type) {
    const config = LIMITS[type];
    if (!config || !actorId) {
        return;
    }

    const key = `${config.prefix}:${actorId}`;

    try {
        const count = await redisCli.incr(key);
        if (count === 1) {
            await redisCli.expire(key, config.windowSec);
        }

        if (count > config.max) {
            const retryAfterSeconds = await getRetryAfterSeconds(key);
            throw new TooManyRequestsError(
                "Too many postcode requests. Please wait and try again.",
                { retryAfterSeconds }
            );
        }
    } catch (error) {
        if (error instanceof TooManyRequestsError) {
            throw error;
        }
        console.warn(`[postcodeRateLimit] Redis unavailable for ${type}:`, error.message);
    }
}

function createPostcodeRateLimit(type) {
    return async (req, res, next) => {
        try {
            const actorId = getPostcodeActorId(req);
            await assertRateLimit(actorId, type);
            next();
        } catch (error) {
            next(error);
        }
    };
}

module.exports = {
    postcodeAutocompleteRateLimit: createPostcodeRateLimit("autocomplete"),
    postcodeValidateRateLimit: createPostcodeRateLimit("validate"),
};

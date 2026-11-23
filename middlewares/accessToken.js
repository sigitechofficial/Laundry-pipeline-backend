require('dotenv').config()
const { appSessionKey } = require('../utils/sessionKeys');
const { sessionFieldOf } = require('../utils/sessionIdentity');
const { verify } = require('jsonwebtoken')
const redisCli = require('../redis/redis')
const { attachShopAgentContext } = require('../utils/shopAgentContext')
const { sendIfAccountBlocked } = require('./rejectBlockedAccount')

module.exports = async function validateAccessToken(req, res, next) {
    try {
        let accessToken = req.cookies.accessToken
        console.log("URL---------------------------->>", req.url);

        if (!accessToken) {
            accessToken = req.headers['accesstoken'] || req.headers['x-access-token'];
        }

        if (!accessToken) {
            throw new Error();
        }

        const validateToken = verify(accessToken, process.env.JWT_ACCESS_SECRET)

        if (await sendIfAccountBlocked(validateToken.id, res)) {
            return;
        }

        // The session of this app install (utils/appSession.js: deviceId, or a legacy dvToken).
        const sessionField = sessionFieldOf(validateToken);
        const redisToken = await redisCli.hGetAll(appSessionKey(validateToken.id));
        if (!sessionField || !redisToken || !redisToken[sessionField]) {
            throw new Error("Invalid Token")
        }

        const redis_Validate = verify(redisToken[sessionField], process.env.JWT_ACCESS_SECRET)

        req.user = redis_Validate;
        attachShopAgentContext(req);
        try {
            const { runWithBookingActor } = require('../utils/bookingActorContext');
            return runWithBookingActor(req.user, () => next());
        } catch (_err) {
            return next();
        }

    } catch (error) {
        return res.status(403).json({
            status: '0',
            message: "Access Denied",
            data: {},
            error: 'You are not authorized to access it'
        })
    }
}

require('dotenv').config();
const { verify } = require('jsonwebtoken');
const redisCli = require('../redis/redis');

module.exports = async function validateAccessToken(req, res, next) {
    try {
        // 1. Try cookie first
        let accessToken = req.cookies.accessToken;

        // 2. Fall back to accesstoken / x-access-token header
        if (!accessToken) {
            accessToken = req.headers['accesstoken'] || req.headers['x-access-token'];
        }

        // 3. Fall back to Authorization: Bearer <token> header
        if (!accessToken && req.headers['authorization']) {
            const authHeader = req.headers['authorization'];
            if (authHeader.startsWith('Bearer ')) {
                accessToken = authHeader.slice(7);
            }
        }

        if (!accessToken) {
            return res.status(403).json({
                status: '0',
                message: 'Access Denied',
                data: {},
                error: 'Access token not found'
            });
        }

        // Verify JWT signature
        const validateToken = verify(accessToken, process.env.JWT_ACCESS_SECRET);

        // Validate token still exists in Redis (covers logout / revocation)
        const redisToken = await redisCli.hGetAll(`tsh${validateToken.id}`);
        if (!redisToken || !redisToken[validateToken.dvToken]) {
            return res.status(403).json({
                status: '0',
                message: 'Access Denied',
                data: {},
                error: 'Session expired or logged out. Please sign in again.'
            });
        }

        // Re-verify the stored token from Redis for extra safety
        const storedToken = verify(redisToken[validateToken.dvToken], process.env.JWT_ACCESS_SECRET);

        req.user = storedToken;
        next();

    } catch (error) {
        return res.status(403).json({
            status: '0',
            message: 'Access Denied',
            data: {},
            error: 'You are not authorized to access this resource'
        });
    }
};

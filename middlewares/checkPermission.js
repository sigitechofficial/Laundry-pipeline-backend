require('dotenv').config();
const { users, permissions } = require('../models');

const METHOD_TO_COLUMN = {
    get:    'read',
    post:   'create',
    put:    'update',
    patch:  'update',
    delete: 'delete',
};

const USER_CACHE_TTL_MS = 60 * 1000;
const PERM_CACHE_TTL_MS = 60 * 1000;
const userRoleCache = new Map();
const permCache = new Map();

function cacheGet(map, key, ttlMs) {
    const hit = map.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > ttlMs) {
        map.delete(key);
        return null;
    }
    return hit.value;
}

function cacheSet(map, key, value, maxSize = 500) {
    map.set(key, { at: Date.now(), value });
    if (map.size > maxSize) {
        const now = Date.now();
        for (const [k, v] of map) {
            if (now - v.at > USER_CACHE_TTL_MS) map.delete(k);
        }
    }
}

/**
 * Permission Middleware
 *
 * Attach ONCE after validateAccessToken on any router.
 * req.user is already set by validateAccessToken.
 *
 * Flow:
 *  1. Get user's classifiedAsId and roleId from DB using req.user.id
 *  2. If classifiedAsId is null  → owner / super admin → full access, skip check
 *  3. If classifiedAsId is set   → zone admin / employee → check permissions
 *     a. Get featureId from request (header OR body OR query)
 *     b. Look up permissions row: roleId + featureId
 *     c. Map HTTP method to column: GET→read, POST→create, PUT/PATCH→update, DELETE→delete
 *     d. If that column is true → allow, else → 403
 */
module.exports = async function checkPermission(req, res, next) {
    try {
        const userId = req.user?.id;
        let userData = cacheGet(userRoleCache, String(userId), USER_CACHE_TTL_MS);

        if (!userData) {
            // Get user role info from DB using the id in the token
            const row = await users.findByPk(userId, {
                attributes: ['id', 'classifiedAsId', 'roleId']
            });
            if (!row) {
                return res.status(403).json({
                    status: '0',
                    message: 'Access Denied',
                    data: {},
                    error: 'User not found'
                });
            }
            userData = {
                id: row.id,
                classifiedAsId: row.classifiedAsId,
                roleId: row.roleId,
            };
            cacheSet(userRoleCache, String(userId), userData);
        }

        // classifiedAsId === null → owner or super admin → bypass, full access
        if (userData.classifiedAsId === null) {
            return next();
        }

        // ── Zone Admin / Employee from here ──────────────────────────────────

        if (!userData.roleId) {
            return res.status(403).json({
                status: '0',
                message: 'Access Denied',
                data: {},
                error: 'No role assigned. Please contact your admin.'
            });
        }

        // featureId sent by frontend: header, body, or query
        const featureId = req.headers['featureid'] || req.body?.featureId || req.query?.featureId;

        // No featureId → general/system endpoint, allow through.
        // Feature-specific permission is only enforced when featureId is explicitly sent.
        if (!featureId) {
            return next();
        }

        // Which action is being performed based on HTTP method
        const permColumn = METHOD_TO_COLUMN[req.method.toLowerCase()];
        const permKey = `${userData.roleId}:${featureId}`;
        let permValues = cacheGet(permCache, permKey, PERM_CACHE_TTL_MS);

        if (!permValues) {
            // Find permission row for this role + feature
            const permissionRow = await permissions.findOne({
                where: { featureId, roleId: userData.roleId },
                attributes: ['create', 'read', 'update', 'delete']
            });
            permValues = permissionRow ? { ...permissionRow.dataValues } : null;
            cacheSet(permCache, permKey, permValues);
        }

        // No row found or the specific permission (read/create/update/delete) is false
        // NOTE: permissionRow.dataValues is used intentionally because the column name
        // "update" shadows Sequelize's built-in instance.update() method, causing
        // permissionRow['update'] to return a function (truthy) instead of the DB value.
        const permValue = permValues ? permValues[permColumn] : undefined;
        if (!permValues || !permValue) {
            return res.status(403).json({
                status: '0',
                message: 'Access Denied',
                data: {},
                error: `You do not have ${permColumn} access for this feature`
            });
        }

        return next();

    } catch (err) {
        console.error('checkPermission error:', err.message);
        return res.status(403).json({
            status: '0',
            message: 'Access Denied',
            data: {},
            error: 'Authorization check failed'
        });
    }
};

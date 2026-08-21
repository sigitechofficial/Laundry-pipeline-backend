require('dotenv').config();
const { users, permissions, features, zone } = require('../models');
const {
    resolveAdminFeatureKey,
    isSessionAllowlisted,
    getAdminRoutePath,
    toFeatureKey,
} = require('../utils/adminRoutePermissions');
const { isPlatformAdmin, parseZoneId } = require('../utils/adminZoneScope');
const { CLASSIFIED_AS } = require('../constants/systemRoles');

const METHOD_TO_COLUMN = {
    get: 'read',
    post: 'create',
    put: 'update',
    patch: 'update',
    delete: 'delete',
};

const USER_CACHE_TTL_MS = 60 * 1000;
const PERM_CACHE_TTL_MS = 60 * 1000;
const FEATURE_CACHE_TTL_MS = 60 * 1000;
const userRoleCache = new Map();
const permCache = new Map();
const featureKeyCache = new Map();

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

function deny(res, error, extra = {}) {
    return res.status(403).json({
        status: '0',
        message: 'Access Denied',
        data: {},
        error,
        ...extra,
    });
}

function clearPermissionCaches() {
    userRoleCache.clear();
    permCache.clear();
    featureKeyCache.clear();
}

const defaultDeps = {
    async loadUser(userId) {
        const row = await users.findByPk(userId, {
            attributes: ['id', 'classifiedAsId', 'roleId'],
        });
        if (!row) return null;
        return {
            id: row.id,
            classifiedAsId: row.classifiedAsId,
            roleId: row.roleId,
        };
    },
    async loadZoneIdForAdmin(userId) {
        const row = await zone.findOne({
            where: { zoneAdminId: userId },
            attributes: ['id'],
        });
        return parseZoneId(row?.id);
    },
    async loadFeatureIdByKey(featureKey) {
        const cachedMap = cacheGet(featureKeyCache, 'map', FEATURE_CACHE_TTL_MS);
        if (cachedMap && Object.prototype.hasOwnProperty.call(cachedMap, featureKey)) {
            return cachedMap[featureKey];
        }

        const rows = await features.findAll({
            where: { status: true },
            attributes: ['id', 'key', 'title'],
        });
        const map = {};
        for (const row of rows) {
            const id = row.id;
            if (row.key) {
                map[String(row.key)] = id;
                const normalizedKey = toFeatureKey(row.key);
                if (normalizedKey && map[normalizedKey] == null) map[normalizedKey] = id;
            }
            const fromTitle = toFeatureKey(row.title);
            if (fromTitle && map[fromTitle] == null) map[fromTitle] = id;
        }
        cacheSet(featureKeyCache, 'map', map);
        return map[featureKey] ?? null;
    },
    async loadPermission(featureId, roleId) {
        const permissionRow = await permissions.findOne({
            where: { featureId, roleId },
            attributes: ['create', 'read', 'update', 'delete'],
        });
        return permissionRow ? { ...permissionRow.dataValues } : null;
    },
};

/**
 * Permission Middleware
 *
 * Attach ONCE after validateAccessToken on the admin router.
 * Also reused on some agent routes (legacy); shop employees must not be
 * gated by the admin feature map — shop ops use shopAgentContext capabilities.
 * req.user is already set by validateAccessToken.
 *
 * Product rule — super admin:
 *   classifiedAsId === null (e.g. admin@gmail.com) → full access, skip feature check.
 *   Zone filter is NOT forced; they may pass zoneId as an optional filter.
 *
 * Agent shop staff (classifiedAsId === 1, roles 6/8):
 *   Skip admin feature CRUD. Agent routes enforce requireCapability / assignee
 *   checks and controller scoping (assigned jobs vs shop board).
 *
 * Zone admin / employee (classifiedAsId === 2):
 *   Feature is resolved from the route map (utils/adminRoutePermissions).
 *   Client featureid header / body / query is ignored.
 *   Deny when the route has no mapping, the feature row is missing,
 *   the role has no permissions row, or the HTTP-method column is false.
 *   Session allowlist (signOut, notification-preferences) is the only exception.
 */
function createCheckPermission(overrides = {}) {
    const deps = { ...defaultDeps, ...overrides };

    return async function checkPermission(req, res, next) {
        try {
            const userId = req.user?.id;
            let userData = cacheGet(userRoleCache, String(userId), USER_CACHE_TTL_MS);

            if (!userData) {
                const row = await deps.loadUser(userId);
                if (!row) {
                    return deny(res, 'User not found');
                }
                userData = {
                    id: row.id,
                    classifiedAsId: row.classifiedAsId,
                    roleId: row.roleId,
                };
                cacheSet(userRoleCache, String(userId), userData);
            }

            const jwtZoneId = parseZoneId(req.user?.zoneId);
            let zoneId = jwtZoneId;
            if (!isPlatformAdmin(userData.classifiedAsId) && !zoneId) {
                zoneId = await deps.loadZoneIdForAdmin(userData.id);
            }

            req.adminAuthz = {
                isPlatformAdmin: isPlatformAdmin(userData.classifiedAsId),
                classifiedAsId: userData.classifiedAsId ?? null,
                roleId: userData.roleId ?? null,
                zoneId,
            };

            // classifiedAsId == null → owner / super admin → bypass, full access
            if (isPlatformAdmin(userData.classifiedAsId)) {
                return next();
            }

            // Agent shop staff → admin feature map does not apply (agent routes)
            if (
                Number(userData.classifiedAsId) ===
                CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE
            ) {
                return next();
            }

            if (isSessionAllowlisted(req)) {
                return next();
            }

            if (!userData.roleId) {
                return deny(res, 'No role assigned. Please contact your admin.');
            }

            const featureKey = resolveAdminFeatureKey(req);
            if (!featureKey) {
                return deny(res, 'No permission is configured for this action', {
                    path: getAdminRoutePath(req),
                });
            }

            const featureId = await deps.loadFeatureIdByKey(featureKey);
            if (!featureId) {
                return deny(res, 'You do not have access for this feature', {
                    featureKey,
                });
            }

            const permColumn = METHOD_TO_COLUMN[req.method.toLowerCase()];
            if (!permColumn) {
                return deny(res, 'You do not have access for this feature');
            }

            const permKey = `${userData.roleId}:${featureId}`;
            const permHit = permCache.get(permKey);
            let permValues;
            if (!permHit || Date.now() - permHit.at > PERM_CACHE_TTL_MS) {
                permValues = await deps.loadPermission(featureId, userData.roleId);
                cacheSet(permCache, permKey, permValues);
            } else {
                permValues = permHit.value;
            }

            // NOTE: dataValues is used when loading from Sequelize because the
            // column name "update" shadows instance.update().
            const permValue = permValues ? permValues[permColumn] : undefined;
            if (!permValues || !permValue) {
                return deny(res, `You do not have ${permColumn} access for this feature`, {
                    featureKey,
                });
            }

            return next();
        } catch (err) {
            console.error('checkPermission error:', err.message);
            return deny(res, 'Authorization check failed');
        }
    };
}

const checkPermission = createCheckPermission();
checkPermission.create = createCheckPermission;
checkPermission.clearCaches = clearPermissionCaches;

module.exports = checkPermission;

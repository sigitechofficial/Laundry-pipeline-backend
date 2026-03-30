require('dotenv').config();
const { users, permissions } = require('../models');

const METHOD_TO_COLUMN = {
    get:    'read',
    post:   'create',
    put:    'update',
    patch:  'update',
    delete: 'delete',
};

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
        // Get user role info from DB using the id in the token
        const userData = await users.findByPk(req.user.id, {
            attributes: ['id', 'classifiedAsId', 'roleId']
        });

        if (!userData) {
            return res.status(403).json({
                status: '0',
                message: 'Access Denied',
                data: {},
                error: 'User not found'
            });
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

        // Find permission row for this role + feature
        const permissionRow = await permissions.findOne({
            where: { featureId, roleId: userData.roleId },
            attributes: ['create', 'read', 'update', 'delete']
        });

        // No row found or the specific permission (read/create/update/delete) is false
        if (!permissionRow || !permissionRow[permColumn]) {
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

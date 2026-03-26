require('dotenv').config();
const { users, permissions } = require('../models');
const error = require('./error');

const METHOD_TO_COLUMN = {
    get:    'read',
    post:   'create',
    put:    'update',
    patch:  'update',
    delete: 'delete',
};

module.exports = async function validatePermission(req, res, next) {
    try {
        const userData = await users.findByPk(req.user.id, {
            attributes: ['classifiedAsId', 'roleId', 'userTypeId']
        });

        // Owners / admins bypass permission check
        if (userData.userTypeId === 4 || userData.userTypeId === 1) {
            return next();
        }

        const featureId = req.query.featureId || req.body.featureId;

        const feature = req.user.featureData?.find(f => f.id === parseInt(featureId));
        if (!feature) {
            return res.json({
                status: '0',
                message: 'Access Denied',
                data: { error },
                error: 'Feature not found or no access',
            });
        }

        const method = req.method.toLowerCase();
        const permColumn = METHOD_TO_COLUMN[method];

        if (!permColumn) {
            return res.json({
                status: '0',
                message: 'Access Denied',
                data: {},
                error: `Unsupported HTTP method: ${req.method}`,
            });
        }

        const permissionRow = await permissions.findOne({
            where: { featureId, roleId: userData.roleId },
            attributes: ['create', 'read', 'update', 'delete'],
        });

        if (!permissionRow || !permissionRow[permColumn]) {
            throw new Error('Access Denied');
        }

        return next();
    } catch (err) {
        return res.json({
            status: '0',
            message: 'Access Denied',
            data: {},
            error: 'You are not authorized to access it',
        });
    }
};

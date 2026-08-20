'use strict';

const { isSessionAllowlisted } = require('../utils/adminRoutePermissions');
const { applyAdminZoneScope, resolveAuthzFromRequest } = require('../utils/adminZoneScope');

/**
 * Force zone scope from JWT / req.adminAuthz for zone staff.
 * Platform admin (classifiedAsId == null) is unchanged — query zoneId stays a filter.
 */
function enforceAdminZoneScope(req, res, next) {
    if (isSessionAllowlisted(req)) {
        return next();
    }

    const result = applyAdminZoneScope(req, resolveAuthzFromRequest(req));
    if (!result.ok) {
        return res.status(result.status || 403).json({
            status: '0',
            message: 'Access Denied',
            data: {},
            error: result.error,
        });
    }
    return next();
}

module.exports = enforceAdminZoneScope;

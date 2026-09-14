'use strict';

/**
 * Server-owned zone scope for the admin portal.
 *
 * Super admin (classifiedAsId == null): client zoneId is an optional filter.
 * Platform staff (Admin Manager / custom admin roles, roleScope=platform):
 *   same optional zone filter; still gated by feature CRUD.
 * Zone staff (Zone Manager, roleScope=zone): JWT zoneId is mandatory; a client
 *   zoneId that does not match is rejected. Omitting zoneId is filled from JWT.
 */

const { isZoneScopedRole } = require('../constants/systemRoles');

function isPlatformAdmin(classifiedAsId) {
    return classifiedAsId === null || classifiedAsId === undefined;
}

function parseZoneId(value) {
    if (value == null || String(value).trim() === '') return null;
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function clientSentZoneId(container) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) {
        return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(container, 'zoneId')) {
        return undefined;
    }
    return container.zoneId;
}

function resolveAuthzFromRequest(req) {
    if (req?.adminAuthz) return req.adminAuthz;
    const user = req?.user || {};
    return {
        isPlatformAdmin: isPlatformAdmin(user.classifiedAsId),
        classifiedAsId: user.classifiedAsId ?? null,
        roleId: user.roleId ?? null,
        roleScope: user.roleScope || null,
        zoneId: parseZoneId(user.zoneId),
    };
}

function isZoneForcedStaff(authz = {}) {
    if (isPlatformAdmin(authz.classifiedAsId) || authz.isPlatformAdmin) {
        return false;
    }
    return isZoneScopedRole({
        roleId: authz.roleId,
        scope: authz.roleScope,
    });
}

/**
 * @returns {{ ok: true, zoneId: number|null, forced: boolean } | { ok: false, status: number, error: string }}
 */
function resolveScopedZone({
    classifiedAsId,
    jwtZoneId,
    clientZoneId,
    roleId,
    roleScope,
} = {}) {
    if (isPlatformAdmin(classifiedAsId)) {
        return { ok: true, zoneId: parseZoneId(clientZoneId), forced: false };
    }

    if (!isZoneScopedRole({ roleId, scope: roleScope })) {
        return { ok: true, zoneId: parseZoneId(clientZoneId), forced: false };
    }

    const forced = parseZoneId(jwtZoneId);
    if (!forced) {
        return {
            ok: false,
            status: 403,
            error: 'No zone assigned to this account',
        };
    }

    if (clientZoneId !== undefined) {
        const client = parseZoneId(clientZoneId);
        if (client !== forced) {
            return {
                ok: false,
                status: 403,
                error: 'zoneId does not match your assigned zone',
            };
        }
    }

    return { ok: true, zoneId: forced, forced: true };
}

function zoneIdFromRequest(req) {
    if (req?.scopedZoneId != null) return req.scopedZoneId;
    return req?.query?.zoneId;
}

/**
 * Apply JWT zone to query (always, for zone staff) and reject a mismatched
 * client zoneId on query or body. Does not invent body.zoneId on writes.
 */
function applyAdminZoneScope(req, authz = resolveAuthzFromRequest(req)) {
    const classifiedAsId = authz.isPlatformAdmin ? null : authz.classifiedAsId;
    const queryZone = clientSentZoneId(req.query);
    const bodyZone = clientSentZoneId(req.body);
    const scopeArgs = {
        classifiedAsId,
        jwtZoneId: authz.zoneId,
        roleId: authz.roleId,
        roleScope: authz.roleScope,
    };

    if (queryZone !== undefined) {
        const result = resolveScopedZone({
            ...scopeArgs,
            clientZoneId: queryZone,
        });
        if (!result.ok) return result;
    }

    if (bodyZone !== undefined) {
        const result = resolveScopedZone({
            ...scopeArgs,
            clientZoneId: bodyZone,
        });
        if (!result.ok) return result;
    }

    const result = resolveScopedZone({
        ...scopeArgs,
        clientZoneId: queryZone,
    });
    if (!result.ok) return result;

    if (result.forced && result.zoneId != null) {
        req.query = req.query && typeof req.query === 'object' ? req.query : {};
        req.query.zoneId = String(result.zoneId);
        req.scopedZoneId = result.zoneId;
    }

    return result;
}

module.exports = {
    isPlatformAdmin,
    parseZoneId,
    clientSentZoneId,
    resolveAuthzFromRequest,
    isZoneForcedStaff,
    resolveScopedZone,
    zoneIdFromRequest,
    applyAdminZoneScope,
};

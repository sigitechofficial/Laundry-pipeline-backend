/**
 * Resolve shop-owner vs shop-employee identity from JWT / req.user.
 *
 * Agent (shop owner): classifiedAsId is null/undefined → shopAgentId = user.id
 * Shop employee: classifiedAsId === 1 → shopAgentId = user.employeeOff
 *
 * Shop staff roles (seeded):
 *   6 = Laundry Shop Driver
 *   8 = Laundry Shop Manager
 */

const LAUNDRY_SHOP_DRIVER_ROLE_ID = 6;
const LAUNDRY_SHOP_MANAGER_ROLE_ID = 8;

function resolveShopAgentId(user) {
    if (!user || user.id == null) {
        return null;
    }
    const classifiedAsId =
        user.classifiedAsId === undefined || user.classifiedAsId === null
            ? null
            : Number(user.classifiedAsId);

    if (classifiedAsId === 1 && user.employeeOff != null) {
        return Number(user.employeeOff);
    }
    return Number(user.id);
}

function resolveActorUserId(user) {
    if (!user || user.id == null) {
        return null;
    }
    return Number(user.id);
}

function resolveRoleId(user) {
    if (user?.roleId == null) return null;
    return Number(user.roleId);
}

function isShopEmployee(user) {
    return Number(user?.classifiedAsId) === 1;
}

function isShopOwner(user) {
    return !isShopEmployee(user);
}

function isShopManager(user) {
    return isShopEmployee(user) && resolveRoleId(user) === LAUNDRY_SHOP_MANAGER_ROLE_ID;
}

function isShopDriver(user) {
    return isShopEmployee(user) && resolveRoleId(user) === LAUNDRY_SHOP_DRIVER_ROLE_ID;
}

/** Owner or manager — can run shop ops (accept, assign, team). */
function canManageShopOps(user) {
    return isShopOwner(user) || isShopManager(user);
}

/** Owner only — wallet, bank, destructive business settings. */
function canManageShopFinance(user) {
    return isShopOwner(user);
}

/**
 * Attach shopAgentId / actorUserId / role flags onto req (after JWT validated).
 */
function attachShopAgentContext(req) {
    const user = req.user || {};
    req.shopAgentId = resolveShopAgentId(user);
    req.actorUserId = resolveActorUserId(user);
    req.roleId = resolveRoleId(user);
    req.isShopEmployee = isShopEmployee(user);
    req.isShopOwner = isShopOwner(user);
    req.isShopManager = isShopManager(user);
    req.isShopDriver = isShopDriver(user);
    req.canManageShopOps = canManageShopOps(user);
    req.canManageShopFinance = canManageShopFinance(user);
    return req;
}

module.exports = {
    LAUNDRY_SHOP_DRIVER_ROLE_ID,
    LAUNDRY_SHOP_MANAGER_ROLE_ID,
    resolveShopAgentId,
    resolveActorUserId,
    resolveRoleId,
    isShopEmployee,
    isShopOwner,
    isShopManager,
    isShopDriver,
    canManageShopOps,
    canManageShopFinance,
    attachShopAgentContext,
};

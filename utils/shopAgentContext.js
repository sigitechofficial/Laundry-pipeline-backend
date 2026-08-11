/**
 * Resolve shop-owner vs shop-employee identity from JWT / req.user.
 *
 * Agent (shop owner): classifiedAsId is null/undefined → shopAgentId = user.id
 * Shop employee: classifiedAsId === 1 → shopAgentId = user.employeeOff
 *
 * Shop staff roles (seeded / system) — see constants/systemRoles.js:
 *   6 = Laundry Shop Driver
 *   8 = Laundry Shop Manager
 *
 * Admin employees (classifiedAsId === 2, role 7 Zone Admin) are NOT shop actors.
 * Shop ops capabilities are role-based (not feature CRUD checkboxes).
 */

const {
    CLASSIFIED_AS,
    SYSTEM_ROLES,
} = require('../constants/systemRoles');

const LAUNDRY_SHOP_DRIVER_ROLE_ID = SYSTEM_ROLES.LAUNDRY_SHOP_DRIVER;
const LAUNDRY_SHOP_MANAGER_ROLE_ID = SYSTEM_ROLES.LAUNDRY_SHOP_MANAGER;

/** Capability keys returned by getShopCapabilities / login. */
const SHOP_CAPABILITY_KEYS = Object.freeze([
    'canManageShopOps',
    'canAcceptOrders',
    'canAssignStaff',
    'canManageTeam',
    'canRunAssignedJobs',
    'canManageFinance',
]);

function resolveShopAgentId(user) {
    if (!user || user.id == null) {
        return null;
    }
    const classifiedAsId =
        user.classifiedAsId === undefined || user.classifiedAsId === null
            ? null
            : Number(user.classifiedAsId);

    if (classifiedAsId === CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE && user.employeeOff != null) {
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
    return Number(user?.classifiedAsId) === CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE;
}

function isShopOwner(user) {
    // Admin employees are not shop owners
    if (Number(user?.classifiedAsId) === CLASSIFIED_AS.ADMIN_EMPLOYEE) {
        return false;
    }
    return !isShopEmployee(user);
}

function isShopManager(user) {
    return isShopEmployee(user) && resolveRoleId(user) === LAUNDRY_SHOP_MANAGER_ROLE_ID;
}

function isShopDriver(user) {
    return isShopEmployee(user) && resolveRoleId(user) === LAUNDRY_SHOP_DRIVER_ROLE_ID;
}

/**
 * Hard capability matrix for shop actors.
 * Owner: full ops + finance. Manager: ops, no finance. Driver: assigned jobs only.
 * Admin employees get no shop capabilities.
 */
function getShopCapabilities(user) {
    if (Number(user?.classifiedAsId) === CLASSIFIED_AS.ADMIN_EMPLOYEE) {
        return {
            canManageShopOps: false,
            canAcceptOrders: false,
            canAssignStaff: false,
            canManageTeam: false,
            canRunAssignedJobs: false,
            canManageFinance: false,
        };
    }

    if (isShopOwner(user)) {
        return {
            canManageShopOps: true,
            canAcceptOrders: true,
            canAssignStaff: true,
            canManageTeam: true,
            canRunAssignedJobs: true,
            canManageFinance: true,
        };
    }

    if (isShopManager(user)) {
        return {
            canManageShopOps: true,
            canAcceptOrders: true,
            canAssignStaff: true,
            canManageTeam: true,
            canRunAssignedJobs: true,
            canManageFinance: false,
        };
    }

    // Driver and any other shop employee: trip runner only
    return {
        canManageShopOps: false,
        canAcceptOrders: false,
        canAssignStaff: false,
        canManageTeam: false,
        canRunAssignedJobs: true,
        canManageFinance: false,
    };
}

function hasShopCapability(user, capability) {
    const caps = getShopCapabilities(user);
    return caps[capability] === true;
}

/** Owner or manager — can run shop ops (accept, assign, team). */
function canManageShopOps(user) {
    return getShopCapabilities(user).canManageShopOps;
}

/** Owner only — wallet, bank, destructive business settings. */
function canManageShopFinance(user) {
    return getShopCapabilities(user).canManageFinance;
}

/**
 * Attach shopAgentId / actorUserId / role flags onto req (after JWT validated).
 */
function attachShopAgentContext(req) {
    const user = req.user || {};
    const capabilities = getShopCapabilities(user);
    req.shopAgentId = resolveShopAgentId(user);
    req.actorUserId = resolveActorUserId(user);
    req.roleId = resolveRoleId(user);
    req.isShopEmployee = isShopEmployee(user);
    req.isShopOwner = isShopOwner(user);
    req.isShopManager = isShopManager(user);
    req.isShopDriver = isShopDriver(user);
    req.capabilities = capabilities;
    req.canManageShopOps = capabilities.canManageShopOps;
    req.canManageShopFinance = capabilities.canManageFinance;
    req.canAcceptOrders = capabilities.canAcceptOrders;
    req.canAssignStaff = capabilities.canAssignStaff;
    req.canManageTeam = capabilities.canManageTeam;
    req.canRunAssignedJobs = capabilities.canRunAssignedJobs;
    return req;
}

module.exports = {
    LAUNDRY_SHOP_DRIVER_ROLE_ID,
    LAUNDRY_SHOP_MANAGER_ROLE_ID,
    SHOP_CAPABILITY_KEYS,
    resolveShopAgentId,
    resolveActorUserId,
    resolveRoleId,
    isShopEmployee,
    isShopOwner,
    isShopManager,
    isShopDriver,
    getShopCapabilities,
    hasShopCapability,
    canManageShopOps,
    canManageShopFinance,
    attachShopAgentContext,
};

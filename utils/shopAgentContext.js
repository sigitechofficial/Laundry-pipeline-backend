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
 * Fine-grained per-employee toggles live in employeeCapabilityOverrides
 * and are merged via getEffectiveShopCapabilities (clamped by ROLE_CAPABILITY_CEILINGS).
 */

const {
    CLASSIFIED_AS,
    SYSTEM_ROLES,
} = require('../constants/systemRoles');

const LAUNDRY_SHOP_DRIVER_ROLE_ID = SYSTEM_ROLES.LAUNDRY_SHOP_DRIVER;
const LAUNDRY_SHOP_MANAGER_ROLE_ID = SYSTEM_ROLES.LAUNDRY_SHOP_MANAGER;

/** Capability keys returned by getShopCapabilities / login / overrides. */
const SHOP_CAPABILITY_KEYS = Object.freeze([
    'canManageShopOps',
    'canAcceptOrders',
    'canAssignStaff',
    'canManageTeam',
    'canRunAssignedJobs',
    'canRunAssignedPickup',
    'canRunAssignedDelivery',
    'canManageFinance',
    'canViewShopOrders',
    'canAccessInvoice',
    'canAccessProcessing',
    'canViewStaffActivity',
    'canManageAutoAssign',
]);

function emptyCapabilities(fill = false) {
    const caps = {};
    for (const key of SHOP_CAPABILITY_KEYS) {
        caps[key] = fill;
    }
    return caps;
}

function withDerivedRunAssignedJobs(caps) {
    const next = { ...caps };
    next.canRunAssignedJobs =
        next.canRunAssignedJobs === true ||
        next.canRunAssignedPickup === true ||
        next.canRunAssignedDelivery === true;
    return next;
}

/**
 * Maximum toggles per role. Overrides cannot grant above these ceilings.
 * Manager: no finance, no auto-assign config, no shopOps edit.
 * Driver: pickup/delivery run only.
 */
const ROLE_CAPABILITY_CEILINGS = Object.freeze({
    owner: Object.freeze(emptyCapabilities(true)),
    manager: Object.freeze(
        withDerivedRunAssignedJobs({
            canManageShopOps: false,
            canAcceptOrders: true,
            canAssignStaff: true,
            canManageTeam: true,
            canRunAssignedPickup: true,
            canRunAssignedDelivery: true,
            canRunAssignedJobs: true,
            canManageFinance: false,
            canViewShopOrders: true,
            canAccessInvoice: true,
            canAccessProcessing: true,
            canViewStaffActivity: true,
            canManageAutoAssign: false,
        })
    ),
    driver: Object.freeze(
        withDerivedRunAssignedJobs({
            canManageShopOps: false,
            canAcceptOrders: false,
            canAssignStaff: false,
            canManageTeam: false,
            canRunAssignedPickup: true,
            canRunAssignedDelivery: true,
            canRunAssignedJobs: true,
            canManageFinance: false,
            canViewShopOrders: false,
            canAccessInvoice: false,
            canAccessProcessing: false,
            canViewStaffActivity: false,
            canManageAutoAssign: false,
        })
    ),
});

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

function resolveCeilingRoleKey(user) {
    if (isShopOwner(user)) return 'owner';
    if (isShopManager(user)) return 'manager';
    if (isShopDriver(user)) return 'driver';
    if (isShopEmployee(user)) return 'driver';
    return null;
}

function getRoleCapabilityCeiling(user) {
    const key = resolveCeilingRoleKey(user);
    if (!key) return emptyCapabilities(false);
    return { ...ROLE_CAPABILITY_CEILINGS[key] };
}

/**
 * Hard capability matrix for shop actors (role presets, no DB overrides).
 * Owner: all YES.
 * Manager: accept/assign/team/invoice/processing/staffActivity/viewShopOrders YES;
 *          shopOps edit NO; finance NO; autoAssign config NO.
 * Driver: runAssignedPickup + Delivery YES; everything else NO.
 */
function getShopCapabilities(user) {
    if (Number(user?.classifiedAsId) === CLASSIFIED_AS.ADMIN_EMPLOYEE) {
        return emptyCapabilities(false);
    }

    if (isShopOwner(user)) {
        return withDerivedRunAssignedJobs(emptyCapabilities(true));
    }

    if (isShopManager(user)) {
        return withDerivedRunAssignedJobs({
            canManageShopOps: false,
            canAcceptOrders: true,
            canAssignStaff: true,
            canManageTeam: true,
            canRunAssignedPickup: true,
            canRunAssignedDelivery: true,
            canRunAssignedJobs: true,
            canManageFinance: false,
            canViewShopOrders: true,
            canAccessInvoice: true,
            canAccessProcessing: true,
            canViewStaffActivity: true,
            canManageAutoAssign: false,
        });
    }

    // Driver and any other shop employee: trip runner only
    return withDerivedRunAssignedJobs({
        canManageShopOps: false,
        canAcceptOrders: false,
        canAssignStaff: false,
        canManageTeam: false,
        canRunAssignedPickup: true,
        canRunAssignedDelivery: true,
        canRunAssignedJobs: true,
        canManageFinance: false,
        canViewShopOrders: false,
        canAccessInvoice: false,
        canAccessProcessing: false,
        canViewStaffActivity: false,
        canManageAutoAssign: false,
    });
}

/**
 * Apply override rows onto a base capability map, clamped by ceiling (if provided).
 * @param {Record<string, boolean>} base
 * @param {Array<{ capabilityKey: string, allowed: boolean }>} overridesArray
 * @param {Record<string, boolean>|null} [ceiling]
 */
function applyCapabilityOverrides(base, overridesArray, ceiling = null) {
    const next = { ...base };
    const rows = Array.isArray(overridesArray) ? overridesArray : [];

    for (const row of rows) {
        const key = row?.capabilityKey;
        if (!key || !SHOP_CAPABILITY_KEYS.includes(key)) continue;
        if (key === 'canRunAssignedJobs') {
            // Derived from pickup/delivery; ignore direct overrides of this key
            continue;
        }
        let allowed = row.allowed === true;
        if (ceiling && ceiling[key] === false) {
            allowed = false;
        }
        next[key] = allowed;
    }

    return withDerivedRunAssignedJobs(next);
}

async function loadCapabilityOverrides(userId) {
    if (userId == null) return [];
    try {
        const { employeeCapabilityOverride } = require('../models');
        const rows = await employeeCapabilityOverride.findAll({
            where: { userId: Number(userId) },
            attributes: ['capabilityKey', 'allowed'],
            raw: true,
        });
        return rows || [];
    } catch (err) {
        console.error('[shopAgentContext] loadCapabilityOverrides failed:', err.message);
        return [];
    }
}

/**
 * Role presets ⊕ per-employee overrides, clamped by ROLE_CAPABILITY_CEILINGS.
 */
async function getEffectiveShopCapabilities(user) {
    const base = getShopCapabilities(user);
    if (!user || user.id == null) {
        return base;
    }
    if (Number(user?.classifiedAsId) === CLASSIFIED_AS.ADMIN_EMPLOYEE) {
        return base;
    }
    // Owners always full — overrides do not apply to shop owner accounts
    if (isShopOwner(user)) {
        return base;
    }

    const overrides = await loadCapabilityOverrides(user.id);
    const ceiling = getRoleCapabilityCeiling(user);
    return applyCapabilityOverrides(base, overrides, ceiling);
}

function hasShopCapability(user, capability, caps = null) {
    const resolved = caps || getShopCapabilities(user);
    return resolved[capability] === true;
}

/** Owner or manager — can run shop ops (accept, assign, team). Legacy helper. */
function canManageShopOps(user) {
    return getShopCapabilities(user).canManageShopOps;
}

/** Owner only — wallet, bank, destructive business settings. */
function canManageShopFinance(user) {
    return getShopCapabilities(user).canManageFinance;
}

function applyCapabilitiesToReq(req, capabilities) {
    req.capabilities = capabilities;
    req.canManageShopOps = capabilities.canManageShopOps;
    req.canManageShopFinance = capabilities.canManageFinance;
    req.canAcceptOrders = capabilities.canAcceptOrders;
    req.canAssignStaff = capabilities.canAssignStaff;
    req.canManageTeam = capabilities.canManageTeam;
    req.canRunAssignedJobs = capabilities.canRunAssignedJobs;
    req.canRunAssignedPickup = capabilities.canRunAssignedPickup;
    req.canRunAssignedDelivery = capabilities.canRunAssignedDelivery;
    req.canViewShopOrders = capabilities.canViewShopOrders;
    req.canAccessInvoice = capabilities.canAccessInvoice;
    req.canAccessProcessing = capabilities.canAccessProcessing;
    req.canViewStaffActivity = capabilities.canViewStaffActivity;
    req.canManageAutoAssign = capabilities.canManageAutoAssign;
}

/**
 * Attach shopAgentId / actorUserId / role flags onto req (after JWT validated).
 * Uses role presets (sync). Prefer attachEffectiveShopAgentContext when gates matter.
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
    applyCapabilitiesToReq(req, capabilities);
    return req;
}

/**
 * Same as attachShopAgentContext but loads DB overrides into req.capabilities.
 */
async function attachEffectiveShopAgentContext(req) {
    attachShopAgentContext(req);
    const capabilities = await getEffectiveShopCapabilities(req.user || {});
    applyCapabilitiesToReq(req, capabilities);
    return req;
}

module.exports = {
    LAUNDRY_SHOP_DRIVER_ROLE_ID,
    LAUNDRY_SHOP_MANAGER_ROLE_ID,
    SHOP_CAPABILITY_KEYS,
    ROLE_CAPABILITY_CEILINGS,
    resolveShopAgentId,
    resolveActorUserId,
    resolveRoleId,
    isShopEmployee,
    isShopOwner,
    isShopManager,
    isShopDriver,
    getShopCapabilities,
    getRoleCapabilityCeiling,
    applyCapabilityOverrides,
    loadCapabilityOverrides,
    getEffectiveShopCapabilities,
    hasShopCapability,
    canManageShopOps,
    canManageShopFinance,
    attachShopAgentContext,
    attachEffectiveShopAgentContext,
};

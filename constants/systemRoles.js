/**
 * System roles & employee kinds — keep Admin portal staff and Agent shop staff separate.
 *
 * classifiedAs:
 *   1 = Laundry Shop Employee  (agent app team members)
 *   2 = Admin Employee         (admin / zone portal staff)
 *
 * roles (seeded system IDs — do not delete):
 *   6 = Laundry Shop Driver    → classifiedAs 1 only
 *   7 = Zone Admin             → classifiedAs 2 only
 *   8 = Laundry Shop Manager   → classifiedAs 1 only
 *
 * Shop ops (accept / assign / team / finance / invoice / processing / trips)
 * for roles 6/8 are enforced by utils/shopAgentContext capabilities — not by
 * feature CRUD checkboxes alone. Per-employee fine-grained overrides live in
 * employeeCapabilityOverrides and are merged via getEffectiveShopCapabilities,
 * clamped by ROLE_CAPABILITY_CEILINGS (drivers cannot gain finance/accept/assign/team;
 * managers cannot gain finance or auto-assign config).
 */

const CLASSIFIED_AS = Object.freeze({
    LAUNDRY_SHOP_EMPLOYEE: 1,
    ADMIN_EMPLOYEE: 2,
});

const SYSTEM_ROLES = Object.freeze({
    LAUNDRY_SHOP_DRIVER: 6,
    ZONE_ADMIN: 7,
    LAUNDRY_SHOP_MANAGER: 8,
});

/** Agent-app shop staff roles (Driver, Manager). */
const AGENT_SHOP_STAFF_ROLE_IDS = Object.freeze([
    SYSTEM_ROLES.LAUNDRY_SHOP_DRIVER,
    SYSTEM_ROLES.LAUNDRY_SHOP_MANAGER,
]);

/** Admin-portal roles (Zone Admin). */
const ADMIN_PORTAL_ROLE_IDS = Object.freeze([
    SYSTEM_ROLES.ZONE_ADMIN,
]);

/** All seeded system role ids that must not be deleted. */
const ALL_SYSTEM_ROLE_IDS = Object.freeze([
    SYSTEM_ROLES.LAUNDRY_SHOP_DRIVER,
    SYSTEM_ROLES.ZONE_ADMIN,
    SYSTEM_ROLES.LAUNDRY_SHOP_MANAGER,
]);

const SYSTEM_ROLE_NAMES = Object.freeze({
    [SYSTEM_ROLES.LAUNDRY_SHOP_DRIVER]: 'Laundry Shop Driver',
    [SYSTEM_ROLES.ZONE_ADMIN]: 'Zone Admin',
    [SYSTEM_ROLES.LAUNDRY_SHOP_MANAGER]: 'Laundry Shop Manager',
});

const ADMIN_PORTAL_ROLE_NAMES = Object.freeze([
    'zone admin',
]);

const AGENT_SHOP_ROLE_NAMES = Object.freeze([
    'laundry shop driver',
    'laundry shop manager',
]);

/** Features visible / assignable in the agent app. */
const AGENT_APP_FEATURE_OF = Object.freeze(['Agent', 'Agent Employee', 'both']);

/** Features for admin / zone portal employees. */
const ADMIN_APP_FEATURE_OF = Object.freeze(['Admin', 'both']);

function normalizeRoleName(name) {
    return (name || '').trim().toLowerCase();
}

function isAgentShopStaffRoleId(roleId) {
    return AGENT_SHOP_STAFF_ROLE_IDS.includes(Number(roleId));
}

function isAdminPortalRoleId(roleId) {
    return ADMIN_PORTAL_ROLE_IDS.includes(Number(roleId));
}

function isSystemRoleId(roleId) {
    return ALL_SYSTEM_ROLE_IDS.includes(Number(roleId));
}

function isAgentShopRoleName(name) {
    return AGENT_SHOP_ROLE_NAMES.includes(normalizeRoleName(name));
}

function isAdminPortalRoleName(name) {
    return ADMIN_PORTAL_ROLE_NAMES.includes(normalizeRoleName(name));
}

module.exports = {
    CLASSIFIED_AS,
    SYSTEM_ROLES,
    AGENT_SHOP_STAFF_ROLE_IDS,
    ADMIN_PORTAL_ROLE_IDS,
    ALL_SYSTEM_ROLE_IDS,
    SYSTEM_ROLE_NAMES,
    ADMIN_PORTAL_ROLE_NAMES,
    AGENT_SHOP_ROLE_NAMES,
    AGENT_APP_FEATURE_OF,
    ADMIN_APP_FEATURE_OF,
    normalizeRoleName,
    isAgentShopStaffRoleId,
    isAdminPortalRoleId,
    isSystemRoleId,
    isAgentShopRoleName,
    isAdminPortalRoleName,
};

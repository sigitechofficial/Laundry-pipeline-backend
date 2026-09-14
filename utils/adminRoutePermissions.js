'use strict';

/**
 * Server-owned admin route → feature.key mapping.
 *
 * Keys match the `features.key` column and the admin-panel sidebar
 * `labelToFeatureKey` convention (e.g. "Order Management" → orderManagement).
 *
 * Client headers / query / body `featureId` are never used for authorization.
 * Super admin (classifiedAsId === null) bypasses this map in checkPermission.
 */

const ADMIN_FEATURE_KEYS = Object.freeze({
    DASHBOARD: 'dashboard',
    ORDER_MANAGEMENT: 'orderManagement',
    CUSTOMER_MANAGEMENT: 'customerManagement',
    SERVICE_MANAGEMENT: 'serviceManagement',
    SHOP_MANAGEMENT: 'shopManagement',
    ZONE_RECORD: 'zoneRecord',
    COUNTRIES_AND_CITIES: 'countriesAndCities',
    POLICIES_MANAGEMENT: 'policiesManagement',
    DRIVER_MANAGEMENT: 'driverManagement',
    EMPLOYEE_MANAGEMENT: 'employeeManagement',
    ROLE_AND_PERMISSION: 'roleAndPermission',
    BLOGS: 'blogs',
    FAQ: 'faq',
    PROMOTION: 'promotion',
    REPORTS: 'reports',
    CUSTOMER_SUPPORT: 'customerSupport',
    NOTIFY_CALL_LOGS: 'notifyCallLogs',
    FCM_PUSH_DEBUG: 'fcmPushDebug',
    SEND_NOTIFICATIONS: 'sendNotifications',
    ALERT_SETTINGS: 'alertSettings',
    DELETE_ACCOUNT_REASONS: 'deleteAccountReasons',
    REVIEW_REASON_CODES: 'reviewReasonCodes',
    SHOP_REVIEWS: 'shopReviews',
});

/** Authenticated session / self-service paths — no feature row required. */
const SESSION_ALLOWLIST_EXACT = new Set([
    '/signOut',
]);

const SESSION_ALLOWLIST_PREFIXES = Object.freeze([
    '/notification-preferences',
]);

const K = ADMIN_FEATURE_KEYS;

/**
 * Longest-prefix first. A path matches when it equals the prefix or continues
 * with `/` (so `/reports` does not steal `/reportsX`).
 */
const ROUTE_FEATURE_PREFIXES = [
    ['/reports', K.REPORTS],

    ['/allOrderDetails', K.ORDER_MANAGEMENT],
    ['/ordersCount', K.ORDER_MANAGEMENT],
    ['/pendingOrders', K.ORDER_MANAGEMENT],
    ['/allCancelOrders', K.ORDER_MANAGEMENT],
    ['/completeOrders', K.ORDER_MANAGEMENT],
    ['/getOnHoldBookings', K.ORDER_MANAGEMENT],
    ['/getOrderForEdit', K.ORDER_MANAGEMENT],
    ['/editOrder', K.ORDER_MANAGEMENT],
    ['/deleteOrder', K.ORDER_MANAGEMENT],
    ['/updateInvoice', K.ORDER_MANAGEMENT],
    ['/invoiceCreation', K.ORDER_MANAGEMENT],
    ['/serviceDetailWithBookingSelection', K.ORDER_MANAGEMENT],
    ['/orderItemsSheet', K.ORDER_MANAGEMENT],
    ['/printLabelData', K.ORDER_MANAGEMENT],
    ['/getServicesAndCategoriesForOrderEdit', K.ORDER_MANAGEMENT],
    ['/allOrderStatuses', K.ORDER_MANAGEMENT],
    ['/action-required-orders', K.ORDER_MANAGEMENT],
    ['/payment-failures', K.ORDER_MANAGEMENT],
    ['/bookings', K.ORDER_MANAGEMENT],
    ['/onHoldOptions', K.ORDER_MANAGEMENT],
    ['/customerOnHoldOptions', K.ORDER_MANAGEMENT],
    ['/getOnHoldCustomerOptions', K.ORDER_MANAGEMENT],
    ['/getOnHoldOptions', K.ORDER_MANAGEMENT],

    ['/getAllCustomers', K.CUSTOMER_MANAGEMENT],
    ['/customerCount', K.CUSTOMER_MANAGEMENT],
    ['/specificCustomerDetails', K.CUSTOMER_MANAGEMENT],
    ['/updateCustomer', K.CUSTOMER_MANAGEMENT],
    ['/addCustomer', K.CUSTOMER_MANAGEMENT],
    ['/deleteCustomer', K.CUSTOMER_MANAGEMENT],

    ['/AddServices', K.SERVICE_MANAGEMENT],
    ['/editServices', K.SERVICE_MANAGEMENT],
    ['/deleteServices', K.SERVICE_MANAGEMENT],
    ['/addCategory', K.SERVICE_MANAGEMENT],
    ['/addSubCategories', K.SERVICE_MANAGEMENT],
    ['/getcategories', K.SERVICE_MANAGEMENT],
    ['/deleteCategories', K.SERVICE_MANAGEMENT],
    ['/editCategories', K.SERVICE_MANAGEMENT],
    ['/getServices', K.SERVICE_MANAGEMENT],
    ['/updateServicesSortOrder', K.SERVICE_MANAGEMENT],
    ['/updateCategoriesSortOrder', K.SERVICE_MANAGEMENT],
    ['/updateSubCategoriesSortOrder', K.SERVICE_MANAGEMENT],
    ['/getSubcategories', K.SERVICE_MANAGEMENT],
    ['/editSubCategories', K.SERVICE_MANAGEMENT],
    ['/serviceCategoriesAssign', K.SERVICE_MANAGEMENT],
    ['/unassignServiceFromCategories', K.SERVICE_MANAGEMENT],
    ['/deleteSubCategories', K.SERVICE_MANAGEMENT],
    ['/getAdminServicesWithCategories', K.SERVICE_MANAGEMENT],
    ['/addServiceTypes', K.SERVICE_MANAGEMENT],
    ['/getSubCategories', K.SERVICE_MANAGEMENT],
    ['/addServiceItems', K.SERVICE_MANAGEMENT],
    ['/createAddOnCategory', K.SERVICE_MANAGEMENT],
    ['/getAllAddOnCategories', K.SERVICE_MANAGEMENT],
    ['/getAddOnCategoryById', K.SERVICE_MANAGEMENT],
    ['/updateAddOnCategory', K.SERVICE_MANAGEMENT],
    ['/updateAddOnCategoriesSortOrder', K.SERVICE_MANAGEMENT],
    ['/deleteAddOnCategory', K.SERVICE_MANAGEMENT],
    ['/createAddOnService', K.SERVICE_MANAGEMENT],
    ['/getAllAddOnServices', K.SERVICE_MANAGEMENT],
    ['/getAddOnServiceById', K.SERVICE_MANAGEMENT],
    ['/updateAddOnService', K.SERVICE_MANAGEMENT],
    ['/updateAddOnServicesSortOrder', K.SERVICE_MANAGEMENT],
    ['/deleteAddOnService', K.SERVICE_MANAGEMENT],
    ['/getRepairGarments', K.SERVICE_MANAGEMENT],
    ['/createRepairGarment', K.SERVICE_MANAGEMENT],
    ['/updateRepairGarment', K.SERVICE_MANAGEMENT],
    ['/deleteRepairGarment', K.SERVICE_MANAGEMENT],
    ['/getRepairOptions', K.SERVICE_MANAGEMENT],
    ['/createRepairOption', K.SERVICE_MANAGEMENT],
    ['/updateRepairOption', K.SERVICE_MANAGEMENT],
    ['/deleteRepairOption', K.SERVICE_MANAGEMENT],
    ['/seedRepairCatalog', K.SERVICE_MANAGEMENT],
    ['/createPreferenceType', K.SERVICE_MANAGEMENT],
    ['/getPreferenceTypes', K.SERVICE_MANAGEMENT],
    ['/editPreferenceType', K.SERVICE_MANAGEMENT],
    ['/deletePreferenceType', K.SERVICE_MANAGEMENT],
    ['/addPreferenceValues', K.SERVICE_MANAGEMENT],
    ['/editPreferenceValues', K.SERVICE_MANAGEMENT],
    ['/deletePreferenceValues', K.SERVICE_MANAGEMENT],
    ['/addServiceWithPreferences', K.SERVICE_MANAGEMENT],
    ['/servicesAndPreferencesData', K.SERVICE_MANAGEMENT],
    ['/unAssignServiceFromPreferences', K.SERVICE_MANAGEMENT],

    ['/getShopInformation', K.SHOP_MANAGEMENT],
    ['/getShopsData', K.SHOP_MANAGEMENT],
    ['/shops', K.SHOP_MANAGEMENT],
    ['/singleShopData', K.SHOP_MANAGEMENT],
    ['/deleteShop', K.SHOP_MANAGEMENT],
    ['/getShopEmployees', K.SHOP_MANAGEMENT],
    ['/getAllEmployeesWithShopInfo', K.SHOP_MANAGEMENT],
    ['/shopAssignmentPolicy', K.SHOP_MANAGEMENT],
    ['/pendingAgents', K.SHOP_MANAGEMENT],
    ['/rejectedAgents', K.SHOP_MANAGEMENT],
    ['/agents', K.SHOP_MANAGEMENT],
    ['/registerAgent', K.SHOP_MANAGEMENT],
    ['/addAgentBusinessInfo', K.SHOP_MANAGEMENT],
    ['/addAgentServices', K.SHOP_MANAGEMENT],
    ['/updateAgentWorkingHours', K.SHOP_MANAGEMENT],
    ['/getAgentCompleteInfo', K.SHOP_MANAGEMENT],
    ['/addAgentAddress', K.SHOP_MANAGEMENT],
    ['/editAgentAddress', K.SHOP_MANAGEMENT],
    ['/getAgentAddress', K.SHOP_MANAGEMENT],
    ['/getShopAddress', K.SHOP_MANAGEMENT],
    ['/addAgentEmployee', K.SHOP_MANAGEMENT],
    ['/updateAgentEmployee', K.SHOP_MANAGEMENT],
    ['/updateAgentEmployeeStatus', K.SHOP_MANAGEMENT],
    ['/getAllAgentEmployees', K.SHOP_MANAGEMENT],
    ['/deleteAgentEmployee', K.SHOP_MANAGEMENT],
    ['/addMachines', K.SHOP_MANAGEMENT],

    ['/addZone', K.ZONE_RECORD],
    ['/addZoneByPostcodes', K.ZONE_RECORD],
    ['/validateLondonPostcode', K.ZONE_RECORD],
    ['/editZoneByPostcodes', K.ZONE_RECORD],
    ['/getZones', K.ZONE_RECORD],
    ['/getZoneById', K.ZONE_RECORD],
    ['/delete-zone', K.ZONE_RECORD],
    ['/updateZone', K.ZONE_RECORD],
    ['/zones', K.ZONE_RECORD],

    ['/addvehicle', K.COUNTRIES_AND_CITIES],
    ['/addCountries', K.COUNTRIES_AND_CITIES],
    ['/updateCountry', K.COUNTRIES_AND_CITIES],
    ['/deleteCountry', K.COUNTRIES_AND_CITIES],
    ['/addCities', K.COUNTRIES_AND_CITIES],
    ['/getCitiesByCountryId', K.COUNTRIES_AND_CITIES],
    ['/updateCity', K.COUNTRIES_AND_CITIES],
    ['/deleteCity', K.COUNTRIES_AND_CITIES],
    ['/getUnitsDistanceAndCurrency', K.COUNTRIES_AND_CITIES],
    ['/getAllUnits', K.COUNTRIES_AND_CITIES],

    ['/adminDashboard', K.DASHBOARD],

    ['/failAttemptInstructions', K.POLICIES_MANAGEMENT],
    ['/failAttemptReasons', K.POLICIES_MANAGEMENT],
    ['/compliance', K.POLICIES_MANAGEMENT],
    ['/runtimeSettings', K.POLICIES_MANAGEMENT],
    ['/platformOperationalHours', K.POLICIES_MANAGEMENT],
    ['/addCancellationPolicy', K.POLICIES_MANAGEMENT],
    ['/getCancellationPolicy', K.POLICIES_MANAGEMENT],
    ['/updateCancellationPolicy', K.POLICIES_MANAGEMENT],
    ['/deleteCancellationPolicy', K.POLICIES_MANAGEMENT],
    ['/setDefaultCancellationPolicy', K.POLICIES_MANAGEMENT],
    ['/toggleCancellationPolicyStatus', K.POLICIES_MANAGEMENT],
    ['/getCancellationPolicyStatistics', K.POLICIES_MANAGEMENT],
    ['/getActiveCancellationPolicy', K.POLICIES_MANAGEMENT],
    ['/addNoShowPolicy', K.POLICIES_MANAGEMENT],
    ['/getNoShowPolicies', K.POLICIES_MANAGEMENT],
    ['/getNoShowPolicy', K.POLICIES_MANAGEMENT],
    ['/updateNoShowPolicy', K.POLICIES_MANAGEMENT],
    ['/deleteNoShowPolicy', K.POLICIES_MANAGEMENT],
    ['/setDefaultNoShowPolicy', K.POLICIES_MANAGEMENT],
    ['/toggleNoShowPolicyStatus', K.POLICIES_MANAGEMENT],
    ['/getActiveNoShowPolicy', K.POLICIES_MANAGEMENT],
    ['/getNoShowPolicyStatistics', K.POLICIES_MANAGEMENT],
    ['/addReschedulePolicy', K.POLICIES_MANAGEMENT],
    ['/getReschedulePolicies', K.POLICIES_MANAGEMENT],
    ['/getReschedulePolicy', K.POLICIES_MANAGEMENT],
    ['/updateReschedulePolicy', K.POLICIES_MANAGEMENT],
    ['/deleteReschedulePolicy', K.POLICIES_MANAGEMENT],
    ['/setDefaultReschedulePolicy', K.POLICIES_MANAGEMENT],
    ['/toggleReschedulePolicyStatus', K.POLICIES_MANAGEMENT],
    ['/getActiveReschedulePolicy', K.POLICIES_MANAGEMENT],
    ['/getReschedulePolicyStatistics', K.POLICIES_MANAGEMENT],
    ['/createReason', K.POLICIES_MANAGEMENT],
    ['/getReasonById', K.POLICIES_MANAGEMENT],
    ['/updateReason', K.POLICIES_MANAGEMENT],
    ['/deleteReason', K.POLICIES_MANAGEMENT],

    ['/countTotalDrivers', K.DRIVER_MANAGEMENT],
    ['/allDriverMiniDetails', K.DRIVER_MANAGEMENT],
    ['/driverStatusChange', K.DRIVER_MANAGEMENT],
    ['/specificdriverDetail', K.DRIVER_MANAGEMENT],
    ['/updateDriver', K.DRIVER_MANAGEMENT],
    ['/deleteDriver', K.DRIVER_MANAGEMENT],
    ['/addDriverByLaundryShop', K.DRIVER_MANAGEMENT],

    ['/getAdminEmployess', K.EMPLOYEE_MANAGEMENT],
    ['/adinEmployeeAdd', K.EMPLOYEE_MANAGEMENT],
    ['/updateEmployee', K.EMPLOYEE_MANAGEMENT],
    ['/updateEmployeeStatus', K.EMPLOYEE_MANAGEMENT],
    ['/getAdminEmployeeDetail', K.EMPLOYEE_MANAGEMENT],
    ['/updateAdminEmployee', K.EMPLOYEE_MANAGEMENT],
    ['/deleteAdminEmployee', K.EMPLOYEE_MANAGEMENT],

    ['/AddLaundryRoles', K.ROLE_AND_PERMISSION],
    ['/updateRoles', K.ROLE_AND_PERMISSION],
    ['/getAllRoles', K.ROLE_AND_PERMISSION],
    ['/addClassifiedAs', K.ROLE_AND_PERMISSION],
    ['/getClassifiedAs', K.ROLE_AND_PERMISSION],
    ['/addfeatures', K.ROLE_AND_PERMISSION],
    ['/getFeatures', K.ROLE_AND_PERMISSION],
    ['/deleteFeature', K.ROLE_AND_PERMISSION],

    ['/createBlog', K.BLOGS],
    ['/updateBlog', K.BLOGS],
    ['/deleteBlog', K.BLOGS],
    ['/toggleBlogStatus', K.BLOGS],

    ['/createFAQ', K.FAQ],
    ['/getFAQ', K.FAQ],
    ['/updateFAQ', K.FAQ],
    ['/deleteFAQ', K.FAQ],
    ['/toggleFAQStatus', K.FAQ],

    ['/addCoupon', K.PROMOTION],
    ['/getAllCoupons', K.PROMOTION],
    ['/getCouponReport', K.PROMOTION],
    ['/getCouponById', K.PROMOTION],
    ['/updateCoupon', K.PROMOTION],
    ['/deleteCoupon', K.PROMOTION],
    ['/createBanner', K.PROMOTION],
    ['/getAllBanners', K.PROMOTION],
    ['/updateBanner', K.PROMOTION],
    ['/deleteBanner', K.PROMOTION],

    ['/getSupportContact', K.CUSTOMER_SUPPORT],
    ['/updateSupportContact', K.CUSTOMER_SUPPORT],

    ['/notify-logs', K.NOTIFY_CALL_LOGS],

    ['/notifications', K.SEND_NOTIFICATIONS],

    ['/getAccountDeletionReasons', K.DELETE_ACCOUNT_REASONS],
    ['/createAccountDeletionReason', K.DELETE_ACCOUNT_REASONS],
    ['/updateAccountDeletionReason', K.DELETE_ACCOUNT_REASONS],
    ['/deleteAccountDeletionReason', K.DELETE_ACCOUNT_REASONS],

    ['/getReviewReasonCodes', K.REVIEW_REASON_CODES],
    ['/createReviewReasonCode', K.REVIEW_REASON_CODES],
    ['/updateReviewReasonCode', K.REVIEW_REASON_CODES],
    ['/deleteReviewReasonCode', K.REVIEW_REASON_CODES],

    ['/shopReviews', K.SHOP_REVIEWS],
].sort((a, b) => b[0].length - a[0].length);

function normalizeAdminPath(rawPath) {
    let path = String(rawPath || '').split('?')[0].trim();
    if (!path) return '';
    if (!path.startsWith('/')) path = `/${path}`;
    if (path.startsWith('/admin/')) path = path.slice(6);
    else if (path === '/admin') path = '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path;
}

function getAdminRoutePath(req) {
    const candidates = [req?.path, req?.url, req?.originalUrl];
    for (const candidate of candidates) {
        if (candidate == null || String(candidate).trim() === '') continue;
        const normalized = normalizeAdminPath(candidate);
        if (normalized) return normalized;
    }
    return '';
}

function pathMatchesPrefix(path, prefix) {
    return path === prefix || path.startsWith(`${prefix}/`);
}

function isSessionAllowlisted(pathOrReq) {
    const path = typeof pathOrReq === 'string'
        ? normalizeAdminPath(pathOrReq)
        : getAdminRoutePath(pathOrReq);
    if (SESSION_ALLOWLIST_EXACT.has(path)) return true;
    return SESSION_ALLOWLIST_PREFIXES.some((prefix) => pathMatchesPrefix(path, prefix));
}

/**
 * Same camelCase rule as admin-panel `labelToFeatureKey`.
 * Used when looking up features by title if `key` spelling differs.
 */
function toFeatureKey(value = '') {
    const cleaned = String(value).replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    if (!cleaned) return '';
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
        const token = parts[0];
        return token.charAt(0).toLowerCase() + token.slice(1);
    }
    return parts
        .map((part, idx) => {
            const lower = part.toLowerCase();
            return idx === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join('');
}

function resolveAdminFeatureKey(pathOrReq) {
    const path = typeof pathOrReq === 'string'
        ? normalizeAdminPath(pathOrReq)
        : getAdminRoutePath(pathOrReq);
    if (!path || isSessionAllowlisted(path)) return null;
    for (const [prefix, key] of ROUTE_FEATURE_PREFIXES) {
        if (pathMatchesPrefix(path, prefix)) return key;
    }
    return null;
}

module.exports = {
    ADMIN_FEATURE_KEYS,
    SESSION_ALLOWLIST_EXACT,
    SESSION_ALLOWLIST_PREFIXES,
    normalizeAdminPath,
    getAdminRoutePath,
    isSessionAllowlisted,
    toFeatureKey,
    resolveAdminFeatureKey,
};

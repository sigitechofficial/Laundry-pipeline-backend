'use strict';

const assert = require('assert');
const {
    ADMIN_FEATURE_KEYS,
    normalizeAdminPath,
    getAdminRoutePath,
    isSessionAllowlisted,
    toFeatureKey,
    resolveAdminFeatureKey,
} = require('./adminRoutePermissions');

function run() {
    assert.strictEqual(normalizeAdminPath('/admin/allOrderDetails?zoneId=1'), '/allOrderDetails');
    assert.strictEqual(normalizeAdminPath('allOrderDetails'), '/allOrderDetails');
    assert.strictEqual(getAdminRoutePath({ originalUrl: '/admin/reports/top-services' }), '/reports/top-services');

    assert.strictEqual(toFeatureKey('Order Management'), ADMIN_FEATURE_KEYS.ORDER_MANAGEMENT);
    assert.strictEqual(toFeatureKey('Reports'), ADMIN_FEATURE_KEYS.REPORTS);

    assert.strictEqual(isSessionAllowlisted('/signOut'), true);
    assert.strictEqual(isSessionAllowlisted('/notification-preferences'), true);
    assert.strictEqual(isSessionAllowlisted('/notification-preferences/catalog'), true);
    assert.strictEqual(isSessionAllowlisted('/allOrderDetails'), false);

    assert.strictEqual(
        resolveAdminFeatureKey({ path: '/allOrderDetails' }),
        ADMIN_FEATURE_KEYS.ORDER_MANAGEMENT
    );
    assert.strictEqual(
        resolveAdminFeatureKey({ path: '/action-required-orders' }),
        ADMIN_FEATURE_KEYS.ORDER_MANAGEMENT
    );
    assert.strictEqual(
        resolveAdminFeatureKey({ originalUrl: '/admin/reports/daily-earnings/zone' }),
        ADMIN_FEATURE_KEYS.REPORTS
    );
    assert.strictEqual(
        resolveAdminFeatureKey({ path: '/getShopsData' }),
        ADMIN_FEATURE_KEYS.SHOP_MANAGEMENT
    );
    assert.strictEqual(
        resolveAdminFeatureKey({ path: '/singleShopData/111/revenue' }),
        ADMIN_FEATURE_KEYS.SHOP_MANAGEMENT
    );
    assert.strictEqual(
        resolveAdminFeatureKey({ path: '/shops/111/settlement-detail' }),
        ADMIN_FEATURE_KEYS.SHOP_MANAGEMENT
    );
    assert.strictEqual(
        resolveAdminFeatureKey({ path: '/addCustomer' }),
        ADMIN_FEATURE_KEYS.CUSTOMER_MANAGEMENT
    );
    assert.strictEqual(
        resolveAdminFeatureKey({ path: '/addCustomer' }),
        ADMIN_FEATURE_KEYS.CUSTOMER_MANAGEMENT
    );
    assert.strictEqual(
        resolveAdminFeatureKey({ path: '/zones/3/catalog' }),
        ADMIN_FEATURE_KEYS.ZONE_RECORD
    );
    assert.strictEqual(
        resolveAdminFeatureKey({ path: '/zones/3/catalog/overrides' }),
        ADMIN_FEATURE_KEYS.ZONE_RECORD
    );
    assert.strictEqual(
        resolveAdminFeatureKey({ originalUrl: '/admin/zones/12/catalog/overrides/reset' }),
        ADMIN_FEATURE_KEYS.ZONE_RECORD
    );
    assert.strictEqual(resolveAdminFeatureKey({ path: '/signOut' }), null);
    assert.strictEqual(resolveAdminFeatureKey({ path: '/not-a-real-admin-route' }), null);

    console.log('adminRoutePermissions tests passed');
}

run();

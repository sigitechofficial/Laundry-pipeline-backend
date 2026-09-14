'use strict';

/**
 * Canonical Admin portal feature keys used by checkPermission / sidebar.
 * Idempotent: insert missing keys only. Never wipe extra feature rows.
 *
 * Also backfills roles.scope for Zone Admin (7) when the column exists.
 */

const { ADMIN_FEATURE_KEYS } = require('../utils/adminRoutePermissions');

const ADMIN_FEATURES = [
  { key: ADMIN_FEATURE_KEYS.DASHBOARD, title: 'Dashboard' },
  { key: ADMIN_FEATURE_KEYS.ORDER_MANAGEMENT, title: 'Order Management' },
  { key: ADMIN_FEATURE_KEYS.CUSTOMER_MANAGEMENT, title: 'Customer Management' },
  { key: ADMIN_FEATURE_KEYS.SERVICE_MANAGEMENT, title: 'Service Management' },
  { key: ADMIN_FEATURE_KEYS.SHOP_MANAGEMENT, title: 'Shop Management' },
  { key: ADMIN_FEATURE_KEYS.ZONE_RECORD, title: 'Zone Record' },
  { key: ADMIN_FEATURE_KEYS.COUNTRIES_AND_CITIES, title: 'Countries and Cities' },
  { key: ADMIN_FEATURE_KEYS.POLICIES_MANAGEMENT, title: 'Policies Management' },
  { key: ADMIN_FEATURE_KEYS.DRIVER_MANAGEMENT, title: 'Driver Management' },
  { key: ADMIN_FEATURE_KEYS.EMPLOYEE_MANAGEMENT, title: 'Employee Management' },
  { key: ADMIN_FEATURE_KEYS.ROLE_AND_PERMISSION, title: 'Role and Permission' },
  { key: ADMIN_FEATURE_KEYS.BLOGS, title: 'Blogs' },
  { key: ADMIN_FEATURE_KEYS.FAQ, title: 'FAQ' },
  { key: ADMIN_FEATURE_KEYS.PROMOTION, title: 'Promotion' },
  { key: ADMIN_FEATURE_KEYS.REPORTS, title: 'Reports' },
  { key: ADMIN_FEATURE_KEYS.CUSTOMER_SUPPORT, title: 'Customer Support' },
  { key: ADMIN_FEATURE_KEYS.NOTIFY_CALL_LOGS, title: 'Notify / Call Logs' },
  { key: ADMIN_FEATURE_KEYS.FCM_PUSH_DEBUG, title: 'FCM Push Debug' },
  { key: ADMIN_FEATURE_KEYS.SEND_NOTIFICATIONS, title: 'Send Notifications' },
  { key: ADMIN_FEATURE_KEYS.ALERT_SETTINGS, title: 'Alert Settings' },
  { key: ADMIN_FEATURE_KEYS.DELETE_ACCOUNT_REASONS, title: 'Delete Account Reasons' },
  { key: ADMIN_FEATURE_KEYS.REVIEW_REASON_CODES, title: 'Review Reason Codes' },
  { key: ADMIN_FEATURE_KEYS.SHOP_REVIEWS, title: 'Shop Reviews' },
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(
      `SELECT id, \`key\` FROM features WHERE deletedAt IS NULL`
    );
    const existingKeys = new Set(
      (existing || []).map((row) => String(row.key || '')).filter(Boolean)
    );

    const now = new Date();
    const rows = ADMIN_FEATURES.filter((item) => !existingKeys.has(item.key)).map((item) => ({
      title: item.title,
      status: true,
      featureOf: 'Admin',
      key: item.key,
      createdAt: now,
      updatedAt: now,
    }));

    if (rows.length) {
      await queryInterface.bulkInsert('features', rows);
      console.log(`[seed] Inserted ${rows.length} Admin feature catalog rows`);
    } else {
      console.log('[seed] Admin feature catalog keys already present');
    }

    const roleDef = await queryInterface.describeTable('roles').catch(() => ({}));
    if (roleDef && Object.prototype.hasOwnProperty.call(roleDef, 'scope')) {
      await queryInterface.sequelize.query(
        `UPDATE roles SET scope = 'zone' WHERE id = 7`
      );
    }
  },

  async down() {
    // Do not delete catalog rows — they may be in use by live roles.
  },
};

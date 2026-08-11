'use strict';

const adminAlertService = require('../../services/Admin/adminAlertService');
const ResponseHelper = require('../../utils/responseHelper');
const { ValidationError } = require('../../middlewares/universalErrorHandler');
const { isValidAlertType } = require('../../constants/adminAlertTypes');

/**
 * GET /admin/notification-preferences
 */
exports.getPreferences = async (req, res) => {
    const adminUserId = req.user?.id;
    const data = await adminAlertService.getPreferencesForAdmin(adminUserId);
    return ResponseHelper.success(res, 'Admin notification preferences', data);
};

/**
 * GET /admin/notification-preferences/catalog
 */
exports.getCatalog = async (_req, res) => {
    const { ADMIN_ALERT_TYPES, ADMIN_ALERT_TYPE_KEYS } = adminAlertService;
    const alerts = ADMIN_ALERT_TYPE_KEYS.map((key) => ({
        alertType: key,
        ...ADMIN_ALERT_TYPES[key],
    }));
    return ResponseHelper.success(res, 'Admin alert catalog', { alerts });
};

/**
 * PATCH /admin/notification-preferences
 * Body: { preferences: { pickup_late: true, payment_failed: false, ... } }
 */
exports.updatePreferences = async (req, res) => {
    const adminUserId = req.user?.id;
    const toggles = {};

    const rawPrefs = req.body?.preferences;
    if (rawPrefs && typeof rawPrefs === 'object') {
        for (const [key, value] of Object.entries(rawPrefs)) {
            if (isValidAlertType(key)) toggles[key] = Boolean(value);
        }
    }

    for (const [key, value] of Object.entries(req.body || {})) {
        if (key === 'preferences') continue;
        if (isValidAlertType(key)) toggles[key] = Boolean(value);
    }

    if (!Object.keys(toggles).length) {
        throw new ValidationError('No valid alert preferences provided');
    }

    const data = await adminAlertService.updatePreferencesForAdmin(adminUserId, toggles);
    return ResponseHelper.success(res, 'Notification preferences updated', data);
};

/**
 * POST /admin/notification-preferences/demo
 * Body: { alertType?: string, alertTypes?: string[], force?: boolean }
 * Sends demo push(es) only to the logged-in admin so they can verify flags/FCM.
 */
exports.sendDemo = async (req, res) => {
    const adminUserId = req.user?.id;
    if (!adminUserId) {
        throw new ValidationError('Admin user required');
    }

    const body = req.body || {};
    let alertTypes = [];
    if (body.alertType && isValidAlertType(body.alertType)) {
        alertTypes = [body.alertType];
    } else if (Array.isArray(body.alertTypes)) {
        alertTypes = body.alertTypes.filter(isValidAlertType);
    }

    const data = await adminAlertService.sendDemoAlerts(adminUserId, {
        alertTypes,
        force: Boolean(body.force),
    });

    const msg = `Demo alerts: ${data.successCount} sent, ${data.skippedCount} skipped, ${data.failedCount} failed`;
    return ResponseHelper.success(res, msg, data);
};

'use strict';

const { users, booking, adminNotificationPreference } = require('../../models');
const { sendNotification, sendNotificationToTokens } = require('../../utils/notification');
const {
    ADMIN_ALERT_TYPES,
    ADMIN_ALERT_TYPE_KEYS,
    DEMO_ALERT_SAMPLES,
    isValidAlertType,
    inferAlertType,
} = require('../../constants/adminAlertTypes');

/**
 * Resolve active admins (userTypeId 1, status true).
 */
async function resolveAdmins({ adminId = null, zoneId = null } = {}) {
    if (adminId) {
        const admin = await users.findOne({
            where: { id: adminId, userTypeId: 1, status: true },
            attributes: ['id', 'firstName', 'lastName', 'email', 'dvToken'],
        });
        return admin ? [admin] : [];
    }

    const where = { userTypeId: 1, status: true };
    // Future: zone-scoped admins via zone.zoneAdminId
    void zoneId;

    return users.findAll({
        where,
        attributes: ['id', 'firstName', 'lastName', 'email', 'dvToken'],
    });
}

/**
 * Load preference map for one admin: { alertType: enabled }.
 * Missing rows use defaultEnabled from ADMIN_ALERT_TYPES.
 */
async function getPreferenceMapForAdmin(adminUserId) {
    const rows = await adminNotificationPreference.findAll({
        where: { adminUserId },
        attributes: ['alertType', 'enabled'],
    });
    const map = {};
    for (const key of ADMIN_ALERT_TYPE_KEYS) {
        map[key] = ADMIN_ALERT_TYPES[key].defaultEnabled;
    }
    for (const row of rows) {
        if (isValidAlertType(row.alertType)) {
            map[row.alertType] = Boolean(row.enabled);
        }
    }
    return map;
}

/**
 * Full catalog + current admin toggles for the settings UI.
 */
async function getPreferencesForAdmin(adminUserId) {
    const prefMap = await getPreferenceMapForAdmin(adminUserId);
    const alerts = ADMIN_ALERT_TYPE_KEYS.map((key) => ({
        alertType: key,
        ...ADMIN_ALERT_TYPES[key],
        enabled: prefMap[key],
    }));

    const byCategory = alerts.reduce((acc, item) => {
        const cat = item.category || 'other';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(item);
        return acc;
    }, {});

    return { alerts, byCategory, adminUserId };
}

/**
 * Upsert toggles: { pickup_late: true, payment_failed: false, ... }
 */
async function updatePreferencesForAdmin(adminUserId, toggles = {}) {
    const updates = [];
    for (const [alertType, enabled] of Object.entries(toggles)) {
        if (!isValidAlertType(alertType)) continue;
        const [row] = await adminNotificationPreference.findOrCreate({
            where: { adminUserId, alertType },
            defaults: { enabled: Boolean(enabled) },
        });
        if (row.enabled !== Boolean(enabled)) {
            await row.update({ enabled: Boolean(enabled) });
        }
        updates.push({ alertType, enabled: Boolean(enabled) });
    }
    return getPreferencesForAdmin(adminUserId);
}

async function isAlertEnabledForAdmin(adminUserId, alertType) {
    if (!isValidAlertType(alertType)) return true;
    const row = await adminNotificationPreference.findOne({
        where: { adminUserId, alertType },
        attributes: ['enabled'],
    });
    if (!row) return ADMIN_ALERT_TYPES[alertType].defaultEnabled;
    return Boolean(row.enabled);
}

/**
 * Send push to admin using deviceTokens, falling back to users.dvToken.
 */
async function sendToAdminUser(admin, title, body, data) {
    const result = await sendNotification(admin.id, title, body, data);
    if (result.sent) {
        return { ...result, adminId: admin.id, usedFallback: false };
    }

    const dvToken = typeof admin.dvToken === 'string' ? admin.dvToken.trim() : '';
    if (!dvToken) {
        return {
            sent: false,
            adminId: admin.id,
            reason: result.reason || 'NO_TOKENS',
            usedFallback: false,
        };
    }

    const fallback = await sendNotificationToTokens(dvToken, title, body, data, {
        tagPrefix: `admin_${admin.id}`,
    });
    return {
        ...fallback,
        adminId: admin.id,
        usedFallback: true,
    };
}

/**
 * Main entry — respects per-admin alert flags.
 */
async function sendAdminAlert({
    alertType,
    title,
    body,
    data = {},
    bookingId = null,
    zoneId = null,
    adminId = null,
} = {}) {
    let resolvedType = alertType;
    let bookingStatusId = null;

    if (bookingId) {
        const bookingRow = await booking.findByPk(bookingId, {
            attributes: ['id', 'orderTrackId', 'bookingStatusId', 'zoneId'],
        });
        if (bookingRow) {
            bookingStatusId = bookingRow.bookingStatusId;
            if (!zoneId && bookingRow.zoneId) zoneId = bookingRow.zoneId;
            if (!data.orderTrackId && bookingRow.orderTrackId) {
                data.orderTrackId = bookingRow.orderTrackId;
            }
            if (!data.bookingId) data.bookingId = String(bookingId);
        }
    }

    if (!resolvedType) {
        resolvedType = inferAlertType({
            title,
            body,
            data,
            bookingStatusId,
        });
    }

    if (!isValidAlertType(resolvedType)) {
        resolvedType = 'agent_assistance';
    }

    const meta = ADMIN_ALERT_TYPES[resolvedType] || {};
    const payload = {
        ...data,
        alertType: resolvedType,
        type: resolvedType,
        priority: data.priority || meta.priority || 'normal',
    };
    if (bookingId != null) payload.bookingId = String(bookingId);

    const admins = await resolveAdmins({ adminId, zoneId });
    if (!admins.length) {
        return {
            alertType: resolvedType,
            totalAdmins: 0,
            successCount: 0,
            skippedCount: 0,
            results: [],
        };
    }

    const results = [];
    let successCount = 0;
    let skippedCount = 0;

    for (const admin of admins) {
        const enabled = await isAlertEnabledForAdmin(admin.id, resolvedType);
        if (!enabled) {
            skippedCount += 1;
            results.push({
                adminId: admin.id,
                adminName: `${admin.firstName} ${admin.lastName}`.trim(),
                success: false,
                skipped: true,
                reason: 'ALERT_DISABLED',
            });
            continue;
        }

        try {
            const result = await sendToAdminUser(admin, title, body, payload);
            if (result.sent) successCount += 1;
            results.push({
                adminId: admin.id,
                adminName: `${admin.firstName} ${admin.lastName}`.trim(),
                success: Boolean(result.sent),
                skipped: false,
                result,
            });
        } catch (err) {
            console.error(`[adminAlert] failed for admin ${admin.id}:`, err.message);
            results.push({
                adminId: admin.id,
                adminName: `${admin.firstName} ${admin.lastName}`.trim(),
                success: false,
                skipped: false,
                error: err.message,
            });
        }
    }

    console.log(
        `[adminAlert] type=${resolvedType} sent=${successCount} skipped=${skippedCount} booking=${bookingId || '-'}`
    );

    return {
        alertType: resolvedType,
        totalAdmins: admins.length,
        successCount,
        skippedCount,
        results,
    };
}

/**
 * Demo push for one or more alert types — only to the requesting admin.
 * @param {number} adminUserId
 * @param {{ alertTypes?: string[], force?: boolean }} options
 *   force=true sends even if the preference toggle is Off (to verify FCM).
 */
async function sendDemoAlerts(adminUserId, options = {}) {
    const force = Boolean(options.force);
    let types = Array.isArray(options.alertTypes) ? options.alertTypes.filter(isValidAlertType) : [];
    if (!types.length) {
        types = [...ADMIN_ALERT_TYPE_KEYS];
    }

    const prefMap = await getPreferenceMapForAdmin(adminUserId);
    const results = [];

    for (const alertType of types) {
        const meta = ADMIN_ALERT_TYPES[alertType] || {};
        const sample = DEMO_ALERT_SAMPLES[alertType] || {
            title: `[DEMO] ${meta.label || alertType}`,
            body: meta.description || `Demo alert for ${alertType}`,
        };
        const preferenceEnabled = prefMap[alertType] !== false;

        if (!force && !preferenceEnabled) {
            results.push({
                alertType,
                label: meta.label || alertType,
                success: false,
                skipped: true,
                reason: 'ALERT_DISABLED',
                message:
                    'Toggle is Off — enable it (or use Force demo) to receive this push.',
                preferenceEnabled: false,
            });
            continue;
        }

        const sendResult = await sendAdminAlert({
            alertType,
            title: sample.title,
            body: sample.body,
            data: {
                demo: true,
                alertType,
                type: alertType,
                orderTrackId: 'DEMO-1001',
                bookingId: '0',
            },
            adminId: adminUserId,
        });

        // When force=true but preference is off, sendAdminAlert still skips —
        // so push directly for demo verification.
        let direct = null;
        if (force && !preferenceEnabled && sendResult.skippedCount > 0) {
            const admins = await resolveAdmins({ adminId: adminUserId });
            const admin = admins[0];
            if (admin) {
                direct = await sendToAdminUser(admin, sample.title, sample.body, {
                    demo: true,
                    alertType,
                    type: alertType,
                    forceDemo: true,
                    orderTrackId: 'DEMO-1001',
                    bookingId: '0',
                    priority: meta.priority || 'normal',
                });
            }
        }

        const sent =
            (direct && direct.sent) ||
            sendResult.successCount > 0;

        results.push({
            alertType,
            label: meta.label || alertType,
            success: Boolean(sent),
            skipped: false,
            preferenceEnabled,
            forced: force && !preferenceEnabled,
            reason: sent
                ? null
                : direct?.reason ||
                  sendResult.results?.[0]?.result?.reason ||
                  sendResult.results?.[0]?.reason ||
                  'SEND_FAILED',
            message: sent
                ? force && !preferenceEnabled
                    ? 'Demo sent (forced while toggle is Off).'
                    : 'Demo push sent to your devices.'
                : 'Push failed — check browser notification permission and re-login to refresh FCM token.',
            sendResult,
            direct,
        });
    }

    return {
        adminUserId,
        force,
        total: results.length,
        successCount: results.filter((r) => r.success).length,
        skippedCount: results.filter((r) => r.skipped).length,
        failedCount: results.filter((r) => !r.success && !r.skipped).length,
        results,
    };
}

module.exports = {
    sendAdminAlert,
    sendDemoAlerts,
    getPreferencesForAdmin,
    updatePreferencesForAdmin,
    getPreferenceMapForAdmin,
    isAlertEnabledForAdmin,
    resolveAdmins,
    ADMIN_ALERT_TYPES,
    ADMIN_ALERT_TYPE_KEYS,
};

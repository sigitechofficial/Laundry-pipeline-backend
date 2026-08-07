'use strict';

const adminPushNotificationService = require('../../services/Admin/adminPushNotificationService');
const ResponseHelper = require('../../utils/responseHelper');

function actorFromReq(req) {
  const u = req.user || {};
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return {
    adminId: u.id || null,
    adminName: name || u.email || null,
  };
}

/**
 * GET /admin/notifications/recipients/search?audience=&q=&limit=
 */
exports.searchRecipients = async (req, res) => {
  const data = await adminPushNotificationService.searchRecipients({
    audience: req.query.audience || 'all',
    q: req.query.q,
    limit: req.query.limit,
  });
  return ResponseHelper.success(res, 'Recipients', data);
};

/**
 * POST /admin/notifications/preview
 * Body: { audience, mode?, userIds? }
 */
exports.previewAudience = async (req, res) => {
  const { audience, mode, userIds } = req.body || {};
  const resolvedMode = String(mode || (userIds?.length ? 'specific' : 'broadcast'));
  const data = await adminPushNotificationService.previewAudience({
    audience,
    userIds: resolvedMode === 'specific' ? userIds : null,
  });
  return ResponseHelper.success(res, 'Audience preview', {
    mode: resolvedMode,
    ...data,
  });
};

/**
 * POST /admin/notifications/send
 * Body: { audience, mode, userIds?, title, body, data?, dryRun?, confirmBroadcast? }
 */
exports.sendNotification = async (req, res) => {
  const result = await adminPushNotificationService.sendAdminPush(
    req.body || {},
    actorFromReq(req)
  );
  const msg = result.dryRun
    ? 'Dry run complete — no notification sent'
    : `Notification send finished: ${result.usersDelivered}/${result.targetedUsers} users delivered`;
  return ResponseHelper.success(res, msg, result);
};

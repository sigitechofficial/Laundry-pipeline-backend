'use strict';

const notifyLogsService = require("../../services/Admin/notifyLogsService");
const ResponseHelper = require("../../utils/responseHelper");

/**
 * GET /admin/notify-logs
 * Query: type=all|notifications|sessions, channel, bookingId, agentUserId, leg,
 *        sessionStatus, startDate, endDate, page, limit
 */
exports.getNotifyLogs = async (req, res) => {
    const data = await notifyLogsService.listNotifyLogs(req.query);
    return ResponseHelper.success(res, "Notify / call logs", data);
};

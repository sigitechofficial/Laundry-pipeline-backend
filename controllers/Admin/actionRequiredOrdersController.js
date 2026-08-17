'use strict';

const ResponseHelper = require('../../utils/responseHelper');
const actionRequiredOrdersService = require('../../services/Admin/actionRequiredOrdersService');

/**
 * GET /admin/action-required-orders
 * Optional query: reason, zoneId, startDate, endDate (order placed)
 */
exports.listActionRequired = async (req, res) => {
    const { zoneId, reason, startDate, endDate } = req.query;
    const limit =
        req.query.limit != null && String(req.query.limit).trim() !== ''
            ? req.query.limit
            : null;
    const scope = { zoneId, startDate, endDate };
    const [data, counts] = await Promise.all([
        actionRequiredOrdersService.listActionRequiredOrders({
            limit,
            reason,
            ...scope,
        }),
        actionRequiredOrdersService.countActionRequiredOrders(scope),
    ]);
    return ResponseHelper.success(res, 'Action required orders', {
        ...data,
        count: data.count,
        filteredCount: data.count,
        totalCount: counts.actionRequiredCount,
        countsByReason:
            counts.actionRequiredBreakdown || data.countsByReason,
    });
};

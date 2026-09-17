'use strict';

const ResponseHelper = require('../../utils/responseHelper');
const actionRequiredOrdersService = require('../../services/Admin/actionRequiredOrdersService');
const { zoneIdFromRequest } = require('../../utils/adminZoneScope');

/**
 * GET /admin/action-required-orders
 *
 * Query (shared list contract, see utils/listQuery):
 *   reason              queue key or "all"
 *   zoneId              optional filter (forced from JWT for zone staff)
 *   startDate/endDate   order placed, inclusive YYYY-MM-DD
 *   search              orderTrackId / booking id / customer name, email, phone / shop / zone
 *   sortBy/sortDir      priority (default) | updatedAt | createdAt | collectionDate |
 *                       deliveryDate | orderAmount | lastPaymentFailureAt
 *   page/limit          window over the merged feed (default limit 25)
 *   export=1            whole filtered set (capped), pagination.exportMode=true
 *
 * Response keeps `items` plus the legacy count fields and adds `pagination`.
 */
exports.listActionRequired = async (req, res) => {
    const { reason, startDate, endDate } = req.query;
    const zoneId = zoneIdFromRequest(req);
    const scope = { zoneId, startDate, endDate };
    const [data, counts] = await Promise.all([
        actionRequiredOrdersService.listActionRequiredOrders({
            reason,
            ...scope,
            listQuery: req.query,
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

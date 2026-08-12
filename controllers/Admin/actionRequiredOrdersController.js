'use strict';

const ResponseHelper = require('../../utils/responseHelper');
const actionRequiredOrdersService = require('../../services/Admin/actionRequiredOrdersService');

/**
 * GET /admin/action-required-orders
 */
exports.listActionRequired = async (req, res) => {
    const data = await actionRequiredOrdersService.listActionRequiredOrders({
        limit: req.query.limit,
        zoneId: req.query.zoneId,
    });
    return ResponseHelper.success(res, 'Action required orders', data);
};

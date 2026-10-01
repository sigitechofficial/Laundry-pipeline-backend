'use strict';

const ResponseHelper = require('../../utils/responseHelper');
const adminShopLiveOpsService = require('../../services/Admin/adminShopLiveOpsService');

/**
 * GET /admin/shopLiveOps/:shopUserId
 * Query: day=today|tomorrow (default today)
 */
async function getShopLiveOps(req, res) {
  const { shopUserId } = req.params;
  const day = String(req.query?.day || 'today').toLowerCase();
  const data = await adminShopLiveOpsService.getShopLiveOps(shopUserId, {
    day: day === 'tomorrow' ? 'tomorrow' : 'today',
  });
  return ResponseHelper.success(res, 'Shop live ops fetched', data);
}

module.exports = {
  getShopLiveOps,
};

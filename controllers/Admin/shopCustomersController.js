'use strict';

const ResponseHelper = require('../../utils/responseHelper');
const shopManagementService = require('../../services/Admin/shopManagementService');

/**
 * GET /admin/singleShopData/:shopId/customers
 * Returning + spend analytics for customers who ordered at this shop.
 */
async function getShopCustomers(req, res) {
  const { shopId } = req.params;
  const data = await shopManagementService.getShopCustomers(shopId, req.query || {});
  return ResponseHelper.success(res, 'Shop customers', data);
}

module.exports = {
  getShopCustomers,
};

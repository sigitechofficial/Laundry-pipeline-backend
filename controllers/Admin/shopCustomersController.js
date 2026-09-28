'use strict';

const ResponseHelper = require('../../utils/responseHelper');
const shopManagementService = require('../../services/Admin/shopManagementService');
const customerShopExclusionService = require('../../services/Admin/customerShopExclusionService');

/**
 * GET /admin/singleShopData/:shopId/customers
 * Returning + spend analytics for customers who ordered at this shop.
 */
async function getShopCustomers(req, res) {
  const { shopId } = req.params;
  const data = await shopManagementService.getShopCustomers(shopId, req.query || {});
  return ResponseHelper.success(res, 'Shop customers', data);
}

/**
 * POST /admin/customerShopExclusions
 * Body: { customerId, shopId, reason? }
 * Excludes customer from marketplace routing to that shop.
 */
async function excludeCustomerFromShop(req, res) {
  const { customerId, shopId, reason } = req.body || {};
  const data = await customerShopExclusionService.excludeCustomerFromShop({
    customerId,
    shopId,
    reason,
    adminId: req.user?.id,
  });
  return ResponseHelper.success(res, 'Customer excluded from shop', data);
}

/**
 * DELETE /admin/customerShopExclusions
 * Body or query: { customerId, shopId }
 */
async function includeCustomerForShop(req, res) {
  const customerId = req.body?.customerId ?? req.query?.customerId;
  const shopId = req.body?.shopId ?? req.query?.shopId;
  const data = await customerShopExclusionService.includeCustomerForShop({
    customerId,
    shopId,
  });
  return ResponseHelper.success(res, 'Customer included for shop again', data);
}

/**
 * GET /admin/customers/:customerId/shop-exclusions
 */
async function listCustomerExclusions(req, res) {
  const data = await customerShopExclusionService.listForCustomer(
    req.params.customerId
  );
  return ResponseHelper.success(res, 'Customer shop exclusions', { exclusions: data });
}

module.exports = {
  getShopCustomers,
  excludeCustomerFromShop,
  includeCustomerForShop,
  listCustomerExclusions,
};

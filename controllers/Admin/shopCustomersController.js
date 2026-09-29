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
    adminId: req.user?.id,
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

const customerShopAssignmentService = require('../../services/Admin/customerShopAssignmentService');

/**
 * GET /admin/customers/:customerId/assignableShops
 * Zone + distance from customer's last order location.
 */
async function getCustomerAssignableShops(req, res) {
  const data = await customerShopAssignmentService.getAssignableShopsForCustomer(
    req.params.customerId
  );
  return ResponseHelper.success(res, 'Assignable shops for customer', data);
}

/**
 * POST /admin/customers/:customerId/shop-assignment
 * Body: { shopId, note?, sourceShopId? }
 */
async function assignCustomerShop(req, res) {
  const { shopId, note, sourceShopId } = req.body || {};
  const data = await customerShopAssignmentService.assignCustomerToShop({
    customerId: req.params.customerId,
    shopId,
    note,
    sourceShopId,
    adminId: req.user?.id,
  });
  return ResponseHelper.success(res, 'Customer assigned to shop', data);
}

/**
 * DELETE /admin/customers/:customerId/shop-assignment
 * Body: { mode: "unlink" | "relink", note? }
 */
async function clearCustomerShopAssignment(req, res) {
  const mode = req.body?.mode ?? req.query?.mode ?? 'unlink';
  const note = req.body?.note ?? req.query?.note;
  const data = await customerShopAssignmentService.clearOrRelinkAssignment({
    customerId: req.params.customerId,
    mode,
    note,
    adminId: req.user?.id,
  });
  return ResponseHelper.success(res, 'Customer shop assignment updated', data);
}

/**
 * GET /admin/customers/:customerId/routing-events
 */
async function listCustomerRoutingEvents(req, res) {
  const data = await customerShopAssignmentService.listRoutingEventsForCustomer(
    req.params.customerId,
    { limit: req.query?.limit }
  );
  return ResponseHelper.success(res, 'Customer routing events', { events: data });
}

/**
 * GET /admin/singleShopData/:shopId/routing-events
 */
async function listShopRoutingEvents(req, res) {
  const shopManagementService = require('../../services/Admin/shopManagementService');
  const resolved = await shopManagementService.resolveShopAddressId(
    req.params.shopId
  );
  const data = await customerShopAssignmentService.listRoutingEventsForShop(
    resolved.shopAddressId,
    { limit: req.query?.limit }
  );
  return ResponseHelper.success(res, 'Shop routing events', {
    shopId: resolved.shopAddressId,
    events: data,
  });
}

module.exports = {
  getShopCustomers,
  excludeCustomerFromShop,
  includeCustomerForShop,
  listCustomerExclusions,
  getCustomerAssignableShops,
  assignCustomerShop,
  clearCustomerShopAssignment,
  listCustomerRoutingEvents,
  listShopRoutingEvents,
};

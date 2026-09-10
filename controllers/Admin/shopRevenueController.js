"use strict";

const ResponseHelper = require("../../utils/responseHelper");
const shopRevenueService = require("../../services/Admin/shopRevenueService");

async function getShopRevenue(req, res) {
  const shopId = req.params.shopId || req.params.Id;
  const data = await shopRevenueService.getShopRevenue(shopId, req.query || {});
  return ResponseHelper.success(res, "Shop revenue", data);
}

module.exports = {
  getShopRevenue,
};

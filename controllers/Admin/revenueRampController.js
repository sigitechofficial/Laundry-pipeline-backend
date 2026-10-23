'use strict';

const ResponseHelper = require('../../utils/responseHelper');
const revenueRampService = require('../../services/Admin/revenueRampService');

async function getRevenueRampPolicy(req, res) {
  const data = await revenueRampService.getSettings();
  return ResponseHelper.success(res, 'New-shop revenue ramp', data);
}

async function updateRevenueRampPolicy(req, res) {
  const data = await revenueRampService.updateSettings(req.body || {});
  return ResponseHelper.success(res, 'New-shop revenue ramp saved', data);
}

module.exports = {
  getRevenueRampPolicy,
  updateRevenueRampPolicy,
};

'use strict';

const shopReviewService = require('../../services/Customer/shopReviewService');
const ResponseHelper = require('../../utils/responseHelper');
const { resolveShopAgentId } = require('../../utils/shopAgentContext');
const { ValidationError } = require('../../middlewares/universalErrorHandler');

async function getShopReviewSummary(req, res) {
  const agentId = resolveShopAgentId(req.user);
  if (!agentId) {
    throw new ValidationError('Unable to resolve shop agent');
  }
  const data = await shopReviewService.getShopSummaryForAgent(agentId);
  return ResponseHelper.success(res, 'Shop review summary retrieved', data);
}

module.exports = {
  getShopReviewSummary,
};

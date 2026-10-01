'use strict';

const ResponseHelper = require('../../utils/responseHelper');
const { resolveShopAgentId } = require('../../utils/shopAgentContext');
const { getShopAcceptCapacityStatus } = require('../../utils/shopAcceptCapacity');

exports.getAcceptCapacity = async (req, res) => {
  const shopUserId = Number(req.shopAgentId ?? resolveShopAgentId(req.user));
  const capacity = await getShopAcceptCapacityStatus(shopUserId);
  return ResponseHelper.success(res, 'Accept capacity', { capacity });
};

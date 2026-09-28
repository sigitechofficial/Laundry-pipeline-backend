'use strict';

const ResponseHelper = require('../../utils/responseHelper');
const { ValidationError } = require('../../middlewares/universalErrorHandler');
const { resolveShopAgentId, resolveActorUserId } = require('../../utils/shopAgentContext');
const { getShopPrinter, saveShopPrinter } = require('../../services/printing/shopPrinterService');
const printJobService = require('../../services/printing/printJobService');

function shopUserIdFromReq(req) {
  return Number(req.shopAgentId ?? resolveShopAgentId(req.user));
}

function actorUserIdFromReq(req) {
  return Number(req.actorUserId ?? resolveActorUserId(req.user));
}

function jobIdFromReq(req) {
  const jobId = Number(req.params.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) throw new ValidationError('jobId required');
  return jobId;
}

exports.getMyShopPrinter = async (req, res) => {
  const printer = await getShopPrinter(shopUserIdFromReq(req));
  return ResponseHelper.success(res, 'Shop printer', { printer });
};

exports.putMyShopPrinter = async (req, res) => {
  const printer = await saveShopPrinter(shopUserIdFromReq(req), req.body);
  return ResponseHelper.success(res, 'Shop printer saved', { printer });
};

exports.listPendingPrintJobs = async (req, res) => {
  const jobs = await printJobService.listPendingForShop(shopUserIdFromReq(req));
  return ResponseHelper.success(res, 'Pending print jobs', { jobs });
};

exports.claimPrintJob = async (req, res) => {
  const claimed = await printJobService.claimJob(
    jobIdFromReq(req),
    shopUserIdFromReq(req),
    actorUserIdFromReq(req)
  );
  return ResponseHelper.success(res, claimed ? 'Print job claimed' : 'Print job not available', {
    claimed,
  });
};

exports.completePrintJob = async (req, res) => {
  const body = req.body || {};
  const job = await printJobService.completeJob(
    jobIdFromReq(req),
    shopUserIdFromReq(req),
    actorUserIdFromReq(req),
    { success: body.success === true, channel: body.channel, message: body.message }
  );
  return ResponseHelper.success(res, 'Print job updated', { job });
};

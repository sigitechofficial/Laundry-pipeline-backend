'use strict';

const ResponseHelper = require('../../utils/responseHelper');
const attemptFailInstructionService = require('../../services/Agent/attemptFailInstructionService');
const attemptFailReasonService = require('../../services/Agent/attemptFailReasonService');
const complianceReportService = require('../../services/Admin/complianceReportService');

exports.listFailInstructionSets = async (req, res) => {
  const sets = await attemptFailInstructionService.listSetsAdmin({
    scope: req.query.scope,
  });
  return ResponseHelper.success(res, 'Fail instruction sets fetched', sets);
};

exports.getFailInstructionSet = async (req, res) => {
  const set = await attemptFailInstructionService.getSetByIdAdmin(req.params.setId);
  return ResponseHelper.success(res, 'Fail instruction set fetched', set);
};

exports.createFailInstruction = async (req, res) => {
  const item = await attemptFailInstructionService.createInstruction({
    setId: req.body.setId || req.params.setId,
    title: req.body.title,
    body: req.body.body,
    sortOrder: req.body.sortOrder,
    isEnabled: req.body.isEnabled,
    isRequired: req.body.isRequired,
  });
  return ResponseHelper.success(res, 'Fail instruction created', item);
};

exports.updateFailInstruction = async (req, res) => {
  const item = await attemptFailInstructionService.updateInstruction(
    req.params.instructionId,
    req.body
  );
  return ResponseHelper.success(res, 'Fail instruction updated', item);
};

exports.reorderFailInstructions = async (req, res) => {
  const set = await attemptFailInstructionService.reorderInstructions(
    req.params.setId,
    req.body.orderedIds || []
  );
  return ResponseHelper.success(res, 'Fail instructions reordered', set);
};

exports.createZoneFailInstructionSet = async (req, res) => {
  const set = await attemptFailInstructionService.createOrActivateZoneSet({
    scope: req.body.scope,
    zoneId: req.body.zoneId,
    name: req.body.name,
  });
  return ResponseHelper.success(res, 'Zone fail instruction set ready', set);
};

exports.setFailInstructionSetActive = async (req, res) => {
  const set = await attemptFailInstructionService.setSetActive(
    req.params.setId,
    req.body.isActive
  );
  return ResponseHelper.success(res, 'Fail instruction set updated', set);
};

exports.listFailReasons = async (req, res) => {
  const rows = await attemptFailReasonService.listAdmin({
    scope: req.query.scope,
  });
  return ResponseHelper.success(res, 'Fail reasons fetched', rows);
};

exports.createFailReason = async (req, res) => {
  const row = await attemptFailReasonService.createAdmin(req.body || {});
  return ResponseHelper.success(res, 'Fail reason created', row);
};

exports.updateFailReason = async (req, res) => {
  const row = await attemptFailReasonService.updateAdmin(
    req.params.reasonId,
    req.body || {}
  );
  return ResponseHelper.success(res, 'Fail reason updated', row);
};

exports.getGeofenceOverrideReport = async (req, res) => {
  const data = await complianceReportService.getGeofenceOverrideAggregates(req.query);
  return ResponseHelper.success(res, 'Geofence override report', data);
};

exports.listComplianceEvents = async (req, res) => {
  const data = await complianceReportService.listComplianceEvents(req.query);
  return ResponseHelper.success(res, 'Compliance events fetched', data);
};

const ResponseHelper = require("../../utils/responseHelper");
const agentSettlementService = require("../../services/Agent/agentSettlementService");

exports.getAgentSettlement = async (req, res) => {
    const agentUserId = parseInt(req.params.agentId, 10);
    const data = await agentSettlementService.getAgentSettlementSummary(agentUserId);
    return ResponseHelper.success(res, "Agent settlement summary", data);
};

exports.getAgentSettlementDetail = async (req, res) => {
    const agentUserId = parseInt(req.params.agentId, 10);
    const { ledgerPage, ledgerLimit, ordersPage, ordersLimit } = req.query;
    const data = await agentSettlementService.getAgentSettlementDetail(agentUserId, {
        ledgerPage,
        ledgerLimit,
        ordersPage,
        ordersLimit,
    });
    return ResponseHelper.success(res, "Agent settlement detail", data);
};

exports.listAgentsWithCashDue = async (req, res) => {
    const { page, limit } = req.query;
    const data = await agentSettlementService.listAgentsWithCashDue({ page, limit });
    return ResponseHelper.success(res, "Agents with cash due", data);
};

exports.listPendingRemittances = async (req, res) => {
    const { page, limit, agentId } = req.query;
    const data = await agentSettlementService.listPendingRemittances({
        page,
        limit,
        agentUserId: agentId ? parseInt(agentId, 10) : undefined,
    });
    return ResponseHelper.success(res, "Pending cash remittances", data);
};

exports.confirmCashRemittance = async (req, res) => {
    const remittanceId = parseInt(req.params.remittanceId, 10);
    const { note } = req.body;
    const data = await agentSettlementService.confirmCashRemittance(
        remittanceId,
        note
    );
    return ResponseHelper.success(res, "Cash remittance confirmed", data);
};

exports.rejectCashRemittance = async (req, res) => {
    const remittanceId = parseInt(req.params.remittanceId, 10);
    const { note } = req.body;
    const data = await agentSettlementService.rejectCashRemittance(
        remittanceId,
        note
    );
    return ResponseHelper.success(res, "Cash remittance rejected", data);
};

exports.recordCashSettlement = async (req, res) => {
    const agentUserId = parseInt(req.params.agentId, 10);
    const { amount, note } = req.body;
    const data = await agentSettlementService.adminRecordCashSettlement(
        agentUserId,
        { amount, note }
    );
    return ResponseHelper.success(res, "Cash settlement recorded", data);
};

exports.recordSettlementAdjustment = async (req, res) => {
    const agentUserId = parseInt(req.params.agentId, 10);
    const { amount, direction, note } = req.body;
    const data = await agentSettlementService.adminRecordAdjustment(agentUserId, {
        amount,
        direction,
        note,
    });
    return ResponseHelper.success(res, "Settlement adjustment recorded", data);
};

exports.recordAgentPayout = async (req, res) => {
    const agentUserId = parseInt(req.params.agentId, 10);
    const { amount, note } = req.body;
    const data = await agentSettlementService.recordAgentPayout(agentUserId, {
        amount,
        note,
    });
    return ResponseHelper.success(res, "Agent payout recorded", data);
};

exports.syncAgentWalletsFromBookings = async (req, res) => {
    const { bookingId, limit } = req.body || {};
    const data = await agentSettlementService.syncAgentWalletsFromBookings({
        bookingId,
        limit,
    });
    return ResponseHelper.success(res, "Wallet sync completed", data);
};

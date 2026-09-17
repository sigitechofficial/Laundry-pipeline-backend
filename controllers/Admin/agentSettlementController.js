const ResponseHelper = require("../../utils/responseHelper");
const agentSettlementService = require("../../services/Agent/agentSettlementService");

exports.getAgentSettlement = async (req, res) => {
    const agentUserId = parseInt(req.params.agentId, 10);
    const data = await agentSettlementService.getAgentSettlementSummary(agentUserId);
    return ResponseHelper.success(res, "Agent settlement summary", data);
};

exports.getAgentSettlementDetail = async (req, res) => {
    const agentUserId = parseInt(req.params.agentId, 10);
    const { ledgerPage, ledgerLimit, ordersPage, ordersLimit, ledgerRail, ledgerType } =
        req.query;
    const data = await agentSettlementService.getAgentSettlementDetail(agentUserId, {
        ledgerPage,
        ledgerLimit,
        ordersPage,
        ordersLimit,
        ledgerRail,
        ledgerType,
    });
    return ResponseHelper.success(res, "Agent settlement detail", data);
};

/**
 * GET /admin/agents/cash-due
 * Query (shared list contract): search, sortBy, sortDir, page, limit, export=1.
 * Response keeps `agents` and adds the standard `pagination` keys.
 */
exports.listAgentsWithCashDue = async (req, res) => {
    const { page, limit, search, sortBy, sortDir } = req.query;
    const data = await agentSettlementService.listAgentsWithCashDue({
        page,
        limit,
        search,
        sortBy,
        sortDir,
        export: req.query.export,
        format: req.query.format,
    });
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
        { amount, note, adminUserId: req.user?.id }
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
        adminUserId: req.user?.id,
    });
    return ResponseHelper.success(res, "Payout sent to the agent's Stripe Connect account", data);
};

exports.syncAgentWalletsFromBookings = async (req, res) => {
    const { bookingId, limit } = req.body || {};
    const data = await agentSettlementService.syncAgentWalletsFromBookings({
        bookingId,
        limit,
    });
    return ResponseHelper.success(res, "Wallet sync completed", data);
};

exports.getShopSettlement = async (req, res) => {
    const data = await agentSettlementService.getShopSettlementSummary(req.params.shopId);
    return ResponseHelper.success(res, "Shop settlement summary", data);
};

exports.getShopSettlementDetail = async (req, res) => {
    const { ledgerPage, ledgerLimit, ordersPage, ordersLimit, ledgerRail, ledgerType } =
        req.query;
    const data = await agentSettlementService.getShopSettlementDetail(req.params.shopId, {
        ledgerPage,
        ledgerLimit,
        ordersPage,
        ordersLimit,
        ledgerRail,
        ledgerType,
    });
    return ResponseHelper.success(res, "Shop settlement detail", data);
};

exports.recordShopCashSettlement = async (req, res) => {
    const { amount, note } = req.body;
    const data = await agentSettlementService.adminRecordShopCashSettlement(req.params.shopId, {
        amount,
        note,
        adminUserId: req.user?.id,
    });
    return ResponseHelper.success(res, "Cash settlement recorded", data);
};

exports.recordShopSettlementAdjustment = async (req, res) => {
    const { amount, direction, note } = req.body;
    const data = await agentSettlementService.adminRecordShopAdjustment(req.params.shopId, {
        amount,
        direction,
        note,
    });
    return ResponseHelper.success(res, "Settlement adjustment recorded", data);
};

exports.recordShopPayout = async (req, res) => {
    const { amount, note } = req.body;
    const data = await agentSettlementService.recordShopPayout(req.params.shopId, {
        amount,
        note,
        adminUserId: req.user?.id,
    });
    return ResponseHelper.success(res, "Payout sent to the agent's Stripe Connect account", data);
};

const agentWithdrawalService = require("../../services/Agent/agentWithdrawalService");

exports.listPendingWithdrawals = async (req, res) => {
    const { page, limit, agentId, shopId } = req.query;
    const data = await agentWithdrawalService.listPendingWithdrawals({
        page,
        limit,
        agentUserId: agentId ? parseInt(agentId, 10) : undefined,
        shopId,
    });
    return ResponseHelper.success(res, "Pending withdrawal requests", data);
};

exports.approveWithdrawal = async (req, res) => {
    const withdrawalId = parseInt(req.params.withdrawalId, 10);
    const { note } = req.body || {};
    const data = await agentWithdrawalService.approveWithdrawal(withdrawalId, {
        note,
        adminUserId: req.user?.id,
    });
    return ResponseHelper.success(res, "Withdrawal approved and transferred", data);
};

exports.rejectWithdrawal = async (req, res) => {
    const withdrawalId = parseInt(req.params.withdrawalId, 10);
    const { note } = req.body || {};
    const data = await agentWithdrawalService.rejectWithdrawal(withdrawalId, {
        note,
        adminUserId: req.user?.id,
    });
    return ResponseHelper.success(res, "Withdrawal request rejected", data);
};

exports.getShopPayoutAccount = async (req, res) => {
    const data = await agentWithdrawalService.getShopPayoutAccount(req.params.shopId);
    return ResponseHelper.success(res, "Shop payout account", data);
};

exports.ensureShopPayoutAccount = async (req, res) => {
    const data = await agentWithdrawalService.ensureShopConnectAccount(req.params.shopId);
    return ResponseHelper.success(res, "Shop payout account ensured", data);
};

exports.createShopPayoutOnboardingLink = async (req, res) => {
    const data = await agentWithdrawalService.createShopPayoutOnboardingLink(
        req.params.shopId
    );
    return ResponseHelper.success(
        res,
        "Stripe Connect onboarding link created — add bank details in Stripe",
        data
    );
};

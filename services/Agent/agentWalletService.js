const {
    booking,
    billingDetails,
    addressDb,
    bussinessInformation,
    wallet,
    units,
    zone,
} = require("../../models");
const { Op } = require("sequelize");
const { NotFoundError } = require("../../middlewares/universalErrorHandler");
const invoiceManagementService = require("./invoiceManagementService");
const { normalizePaymentType } = require("../../utils/invoicePaymentSummary");

const COMMISSION_REFERENCE = "booking_commission";
const CASH_COLLECTED_REFERENCE = "cash_collected";
const CASH_REMITTED_REFERENCE = "cash_remitted";
const ADMIN_SETTLEMENT_REFERENCE = "admin_settlement";
const PAYOUT_REFERENCE = "payout";
// Credit created when an admin pays out (releases) the agent's earnings into the
// agent's withdrawable wallet. This is the ONLY thing the agent sees as their
// wallet "Credit" / available balance. Order commissions are tracked separately
// as earnings and are NOT shown as wallet credit until an admin pays out.
const AGENT_PAYOUT_REFERENCE = "agent_payout";
// Debit created ONLY when an agent withdraws their balance to their own
// (Stripe Connect) account. Nothing else counts as agent-facing "Debited".
// Reserved now; the Stripe transfer flow is added later.
const WITHDRAWAL_REFERENCE = "agent_withdrawal";
const DEFAULT_CURRENCY = "GBP";

async function resolveShopOwnerUserId(laundryShopId) {
    if (!laundryShopId) return null;
    const shop = await addressDb.findByPk(laundryShopId, {
        attributes: ["id", "userId"],
    });
    return shop?.userId || null;
}

async function resolveCurrencyForBooking(bookingRow) {
    if (!bookingRow?.zoneId) return DEFAULT_CURRENCY;
    const zoneRow = await zone.findByPk(bookingRow.zoneId, {
        attributes: ["id", "currencyUnitId"],
        include: [
            {
                model: units,
                as: "currencyUnitZ",
                attributes: ["symbol", "name"],
                required: false,
            },
        ],
    });
    const symbol = zoneRow?.currencyUnitZ?.symbol;
    if (symbol && String(symbol).trim()) {
        return String(symbol).trim().toUpperCase() === "£"
            ? "GBP"
            : String(symbol).trim();
    }
    return DEFAULT_CURRENCY;
}

async function hasWalletEntry(bookingId, referenceType, type) {
    const existing = await wallet.findOne({
        where: {
            bookingId,
            referenceType,
            type,
            status: "completed",
        },
        attributes: ["id"],
    });
    return Boolean(existing);
}

async function hasCommissionCredit(bookingId) {
    return hasWalletEntry(bookingId, COMMISSION_REFERENCE, "credit");
}

async function sumWalletAmount(userId, type, options = {}) {
    const where = {
        userId,
        type,
        status: options.status || "completed",
    };
    if (options.referenceType) {
        where.referenceType = options.referenceType;
    }

    const rows = await wallet.findAll({
        where,
        attributes: ["amount"],
        raw: true,
    });
    return rows.reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
}

/**
 * Cash bucket: full cash bookings + card upfront with balance collected in cash.
 * Card bucket: remaining card bookings.
 */
function classifyAgentEarningChannel(bookingRow) {
    if (!bookingRow) return "card";

    const paymentType = normalizePaymentType(bookingRow.paymentType);
    if (paymentType === "cash") {
        return "cash";
    }

    const collectedVia = bookingRow.balanceCollectedVia;
    if (collectedVia === "cash") {
        return "cash";
    }
    if (collectedVia === "card") {
        return "card";
    }

    if (bookingRow.balancePaymentMethod === "cash") {
        return "cash";
    }

    return "card";
}

async function resolveCashCollectedAmount(bookingId, bookingRow, options = {}) {
    if (options.cashCollectedAmount != null && options.cashCollectedAmount !== "") {
        const parsed = parseFloat(options.cashCollectedAmount);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parseFloat(parsed.toFixed(2));
        }
    }

    const existing = await wallet.findOne({
        where: {
            bookingId,
            referenceType: CASH_COLLECTED_REFERENCE,
            type: "debit",
            status: "completed",
        },
        attributes: ["amount"],
    });
    if (existing) {
        return parseFloat(parseFloat(existing.amount || 0).toFixed(2));
    }

    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const totalOrderAmount = Number(
        paymentSummary?.orderSummary?.totalOrderAmount ?? 0
    );
    if (totalOrderAmount > 0) {
        const channel = classifyAgentEarningChannel(bookingRow);
        if (channel === "cash" && normalizePaymentType(bookingRow.paymentType) === "cash") {
            return parseFloat(totalOrderAmount.toFixed(2));
        }
    }

    return 0;
}

async function recordCashCollectedForBooking({
    bookingId,
    agentUserId,
    cashCollectedAmount,
    currency,
    orderLabel,
}) {
    if (await hasWalletEntry(bookingId, CASH_COLLECTED_REFERENCE, "debit")) {
        return { recorded: false, reason: "already_recorded" };
    }

    const entry = await wallet.create({
        userId: agentUserId,
        bookingId,
        referenceType: CASH_COLLECTED_REFERENCE,
        amount: cashCollectedAmount,
        currency,
        type: "debit",
        status: "completed",
        description: `Cash collected for order #${orderLabel}`,
    });

    return {
        recorded: true,
        amount: cashCollectedAmount,
        walletId: entry.id,
    };
}

/**
 * Credit agent wallet when booking is fully paid. Idempotent per booking.
 * Cash orders also record cash_collected debit (agent physically holds customer cash).
 * @returns {{ credited: boolean, cashRecorded?: boolean, amount?: number, walletId?: number, reason?: string }}
 */
async function creditAgentForPaidBooking(bookingId, options = {}) {
    const bookingRow = await booking.findByPk(bookingId, {
        attributes: [
            "id",
            "orderTrackId",
            "laundryShopId",
            "zoneId",
            "paymentType",
            "balancePaymentMethod",
            "balanceCollectedVia",
        ],
        include: [
            {
                model: billingDetails,
                as: "billingDetail",
                required: false,
                attributes: [
                    "paymentStatus",
                    "agentEarning",
                    "total",
                ],
            },
        ],
    });

    if (!bookingRow) {
        return { credited: false, reason: "booking_not_found" };
    }

    const billing = bookingRow.billingDetail;
    if (!billing || billing.paymentStatus !== "Paid") {
        return { credited: false, reason: "not_paid" };
    }

    const agentEarning = parseFloat(billing.agentEarning || 0);
    if (!agentEarning || agentEarning <= 0) {
        return { credited: false, reason: "no_agent_earning" };
    }

    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const amountDue = Number(paymentSummary?.amountDueNow ?? 0);
    if (amountDue > 0.02) {
        return { credited: false, reason: "balance_still_due" };
    }

    const agentUserId = await resolveShopOwnerUserId(bookingRow.laundryShopId);
    if (!agentUserId) {
        return { credited: false, reason: "no_shop_owner" };
    }

    const currency = await resolveCurrencyForBooking(bookingRow);
    const orderLabel = bookingRow.orderTrackId || String(bookingId);
    const channel = classifyAgentEarningChannel(bookingRow);

    let cashRecorded = false;
    if (channel === "cash") {
        const cashCollectedAmount = await resolveCashCollectedAmount(
            bookingId,
            bookingRow,
            options
        );
        if (!cashCollectedAmount || cashCollectedAmount <= 0) {
            return { credited: false, reason: "cash_not_recorded" };
        }

        const cashResult = await recordCashCollectedForBooking({
            bookingId,
            agentUserId,
            cashCollectedAmount,
            currency,
            orderLabel,
        });
        cashRecorded = cashResult.recorded;
    }

    if (await hasCommissionCredit(bookingId)) {
        return {
            credited: false,
            cashRecorded,
            reason: "already_credited",
        };
    }

    const entry = await wallet.create({
        userId: agentUserId,
        bookingId,
        referenceType: COMMISSION_REFERENCE,
        amount: agentEarning,
        currency,
        type: "credit",
        status: "completed",
        description: `Commission for order #${orderLabel}`,
    });

    return {
        credited: true,
        cashRecorded,
        amount: agentEarning,
        walletId: entry.id,
        agentUserId,
        channel,
    };
}

/**
 * Lifetime agent commission from billing, split by collection channel.
 */
async function sumAgentEarningsBreakdown(laundryShopId) {
    const rows = await billingDetails.findAll({
        where: {
            agentEarning: { [Op.gt]: 0 },
        },
        attributes: ["agentEarning"],
        include: [
            {
                model: booking,
                as: "booking",
                required: true,
                attributes: [
                    "paymentType",
                    "balancePaymentMethod",
                    "balanceCollectedVia",
                ],
                where: { laundryShopId },
            },
        ],
    });

    let total = 0;
    let cash = 0;
    let card = 0;

    for (const row of rows) {
        const amount = parseFloat(row.agentEarning || 0);
        if (!amount) continue;

        total += amount;
        if (classifyAgentEarningChannel(row.booking) === "cash") {
            cash += amount;
        } else {
            card += amount;
        }
    }

    return {
        totalEarning: parseFloat(total.toFixed(2)),
        totalEarningCash: parseFloat(cash.toFixed(2)),
        totalEarningCard: parseFloat(card.toFixed(2)),
    };
}

async function getWalletSummary(agentUserId) {
    const shop = await addressDb.findOne({
        where: {
            userId: agentUserId,
            addressType: "LaundaryShopAddress",
        },
        attributes: ["id", "zoneId"],
    });

    if (!shop) {
        throw new NotFoundError("Agent shop address not found");
    }

    const totalCreditedAll = await sumWalletAmount(agentUserId, "credit");
    const totalDebitedAll = await sumWalletAmount(agentUserId, "debit");

    // Legacy admin payout debits — deprecated, ignored everywhere.
    const totalPayouts = await sumWalletAmount(agentUserId, "debit", {
        referenceType: PAYOUT_REFERENCE,
    });
    // Admin payouts released into the agent's withdrawable wallet (money in).
    const agentPayoutCredits = await sumWalletAmount(agentUserId, "credit", {
        referenceType: AGENT_PAYOUT_REFERENCE,
    });
    // Money the agent has actually withdrawn to their own account. This is the
    // ONLY thing that counts as agent-facing "Debited".
    const totalWithdrawn = await sumWalletAmount(agentUserId, "debit", {
        referenceType: WITHDRAWAL_REFERENCE,
    });
    const pendingWithdrawals = await sumWalletAmount(agentUserId, "debit", {
        referenceType: WITHDRAWAL_REFERENCE,
        status: "pending",
    });

    const totalCashCollected = await sumWalletAmount(agentUserId, "debit", {
        referenceType: CASH_COLLECTED_REFERENCE,
    });
    const totalCashRemitted = await sumWalletAmount(agentUserId, "credit", {
        referenceType: CASH_REMITTED_REFERENCE,
    });
    const pendingCashRemitted = await sumWalletAmount(agentUserId, "credit", {
        referenceType: CASH_REMITTED_REFERENCE,
        status: "pending",
    });
    const totalAdminSettlements = await sumWalletAmount(agentUserId, "credit", {
        referenceType: ADMIN_SETTLEMENT_REFERENCE,
    });

    // Internal cash-settlement balance (drives cash-due accounting). It only
    // considers settlement-type entries: agent payouts (money released to the
    // agent), withdrawals, and legacy payouts must NOT affect it.
    const settlementCredits = totalCreditedAll - agentPayoutCredits;
    const settlementDebits = totalDebitedAll - totalPayouts - totalWithdrawn;
    const balance = parseFloat((settlementCredits - settlementDebits).toFixed(2));

    // Agent's withdrawable wallet:
    //   Credit    = admin payouts released (0 until admin pays out)
    //   Debited   = withdrawals (0 until agent withdraws)
    //   Available = Credit − withdrawn
    const walletCredit = parseFloat(agentPayoutCredits.toFixed(2));
    const availableBalance = parseFloat(
        Math.max(
            agentPayoutCredits - totalWithdrawn - pendingWithdrawals,
            0
        ).toFixed(2)
    );

    const businessInfo = await bussinessInformation.findOne({
        where: { shopAddressId: shop.id },
        attributes: ["connectAccountId", "isConnectAccountConnected"],
    });
    const connectAccountConnected = Boolean(
        businessInfo?.connectAccountId &&
        businessInfo?.isConnectAccountConnected
    );

    let currency = DEFAULT_CURRENCY;
    if (shop.zoneId) {
        const zoneRow = await zone.findByPk(shop.zoneId, {
            attributes: ["id"],
            include: [
                {
                    model: units,
                    as: "currencyUnitZ",
                    attributes: ["symbol"],
                    required: false,
                },
            ],
        });
        const symbol = zoneRow?.currencyUnitZ?.symbol;
        if (symbol) {
            currency =
                String(symbol).trim().toUpperCase() === "£"
                    ? "GBP"
                    : String(symbol).trim();
        }
    }

    const commissionCredits = await wallet.count({
        where: {
            userId: agentUserId,
            referenceType: COMMISSION_REFERENCE,
            type: "credit",
            status: "completed",
        },
    });

    const earnings = await sumAgentEarningsBreakdown(shop.id);

    const cashDueToPlatform = balance < 0 ? parseFloat(Math.abs(balance).toFixed(2)) : 0;
    // "Payable" to the agent = card earnings the platform holds that have NOT yet
    // been paid out. Each admin payout reduces this so the same earnings can't be
    // paid twice. Cash earnings are physically held by the agent, so excluded.
    const platformOwesAgent = parseFloat(
        Math.max(earnings.totalEarningCard - agentPayoutCredits, 0).toFixed(2)
    );

    return {
        balance,
        currency,
        netSettlement: balance,
        cashDueToPlatform,
        platformOwesAgent,
        availableBalance,
        totalEarning: earnings.totalEarning,
        totalEarningCash: earnings.totalEarningCash,
        totalEarningCard: earnings.totalEarningCard,
        totalCashCollected: parseFloat(totalCashCollected.toFixed(2)),
        totalCashRemitted: parseFloat(totalCashRemitted.toFixed(2)),
        pendingCashRemittance: parseFloat(pendingCashRemitted.toFixed(2)),
        totalAdminSettlements: parseFloat(totalAdminSettlements.toFixed(2)),
        totalPayouts: parseFloat(totalPayouts.toFixed(2)),
        totalAgentPayouts: walletCredit,
        totalWithdrawn: parseFloat(totalWithdrawn.toFixed(2)),
        pendingWithdrawals: parseFloat(pendingWithdrawals.toFixed(2)),
        connectAccountConnected,
        canWithdraw: connectAccountConnected && availableBalance >= 1,
        minimumWithdrawal: 1,
        // Agent-facing "Credit" = money released to the agent via admin payout
        // (0 until an admin pays out). Order commissions are NOT counted here.
        totalCredited: walletCredit,
        // Agent-facing "Debited" = withdrawals only (0 until they withdraw).
        totalDebited: parseFloat(totalWithdrawn.toFixed(2)),
        commissionCreditCount: commissionCredits,
    };
}

function hasSettlementActivity(summary) {
    if (!summary) return false;
    return (
        summary.cashDueToPlatform > 0 ||
        summary.pendingCashRemittance > 0 ||
        summary.platformOwesAgent > 0 ||
        summary.totalCashCollected > 0 ||
        summary.commissionCreditCount > 0
    );
}

/**
 * Create wallet ledger rows for paid bookings that pre-date the wallet feature
 * or missed automatic credit (e.g. cash not recorded at delivery).
 */
async function backfillWalletsFromPaidBookings(options = {}) {
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 500, 1), 2000);
    const bookingIdFilter =
        options.bookingId != null && options.bookingId !== ""
            ? parseInt(options.bookingId, 10)
            : null;

    const bookingWhere = {
        laundryShopId: { [Op.ne]: null },
    };
    if (Number.isFinite(bookingIdFilter) && bookingIdFilter > 0) {
        bookingWhere.id = bookingIdFilter;
    }

    const rows = await billingDetails.findAll({
        where: {
            paymentStatus: "Paid",
            agentEarning: { [Op.gt]: 0 },
        },
        attributes: ["bookingId", "agentEarning"],
        include: [
            {
                model: booking,
                as: "booking",
                required: true,
                where: bookingWhere,
                attributes: ["id", "orderTrackId", "paymentType"],
            },
        ],
        limit,
        order: [["updatedAt", "DESC"]],
    });

    const stats = {
        processed: 0,
        credited: 0,
        cashRecorded: 0,
        skipped: [],
    };

    for (const row of rows) {
        stats.processed += 1;
        const result = await creditAgentForPaidBooking(row.bookingId);
        if (result.credited) {
            stats.credited += 1;
        }
        if (result.cashRecorded) {
            stats.cashRecorded += 1;
        }
        if (!result.credited && result.reason && result.reason !== "already_credited") {
            stats.skipped.push({
                bookingId: row.bookingId,
                orderTrackId: row.booking?.orderTrackId || null,
                reason: result.reason,
            });
        }
    }

    return stats;
}

async function getWalletTransactions(agentUserId, options = {}) {
    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const summary = await getWalletSummary(agentUserId);

    const { count, rows } = await wallet.findAndCountAll({
        where: {
            userId: agentUserId,
            // Agent ledger shows only real wallet movements the agent cares about:
            // admin payouts released to them (credit) and their withdrawals (debit).
            // Internal commission / cash-settlement entries are tracked as earnings,
            // not shown here.
            referenceType: {
                [Op.in]: [AGENT_PAYOUT_REFERENCE, WITHDRAWAL_REFERENCE],
            },
        },
        order: [["createdAt", "DESC"]],
        limit,
        offset,
        attributes: [
            "id",
            "amount",
            "currency",
            "type",
            "status",
            "description",
            "bookingId",
            "referenceType",
            "stripeTransferId",
            "failureReason",
            "createdAt",
        ],
        include: [
            {
                model: booking,
                as: "booking",
                attributes: ["id", "orderTrackId"],
                required: false,
            },
        ],
    });

    const totalPages = count > 0 ? Math.ceil(count / limit) : 0;

    return {
        balance: summary.balance,
        currency: summary.currency,
        netSettlement: summary.netSettlement,
        cashDueToPlatform: summary.cashDueToPlatform,
        platformOwesAgent: summary.platformOwesAgent,
        availableBalance: summary.availableBalance,
        totalEarning: summary.totalEarning,
        totalEarningCash: summary.totalEarningCash,
        totalEarningCard: summary.totalEarningCard,
        totalCashCollected: summary.totalCashCollected,
        totalCashRemitted: summary.totalCashRemitted,
        pendingCashRemittance: summary.pendingCashRemittance,
        totalCredited: summary.totalCredited,
        totalAgentPayouts: summary.totalAgentPayouts,
        totalWithdrawn: summary.totalWithdrawn,
        pendingWithdrawals: summary.pendingWithdrawals,
        totalDebited: summary.totalDebited,
        connectAccountConnected: summary.connectAccountConnected,
        canWithdraw: summary.canWithdraw,
        minimumWithdrawal: summary.minimumWithdrawal,
        transactions: rows.map((row) => {
            const plain = row.get({ plain: true });
            return {
                id: plain.id,
                amount: parseFloat(plain.amount || 0),
                currency: plain.currency || summary.currency,
                type: plain.type,
                status: plain.status,
                description: plain.description,
                bookingId: plain.bookingId,
                orderTrackId: plain.booking?.orderTrackId || null,
                referenceType: plain.referenceType,
                stripeTransferId: plain.stripeTransferId,
                failureReason: plain.failureReason,
                createdAt: plain.createdAt,
            };
        }),
        pagination: {
            page,
            limit,
            total: count,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
        },
    };
}

module.exports = {
    COMMISSION_REFERENCE,
    CASH_COLLECTED_REFERENCE,
    CASH_REMITTED_REFERENCE,
    ADMIN_SETTLEMENT_REFERENCE,
    PAYOUT_REFERENCE,
    AGENT_PAYOUT_REFERENCE,
    WITHDRAWAL_REFERENCE,
    classifyAgentEarningChannel,
    creditAgentForPaidBooking,
    backfillWalletsFromPaidBookings,
    hasSettlementActivity,
    getWalletSummary,
    getWalletTransactions,
    hasCommissionCredit,
    resolveShopOwnerUserId,
};

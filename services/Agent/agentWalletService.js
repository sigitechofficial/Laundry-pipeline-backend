const {
    booking,
    billingDetails,
    addressDb,
    bussinessInformation,
    wallet,
    units,
    zone,
    tip,
} = require("../../models");
const { Op } = require("sequelize");
const { NotFoundError } = require("../../middlewares/universalErrorHandler");
const invoiceManagementService = require("./invoiceManagementService");
const { normalizePaymentType } = require("../../utils/invoicePaymentSummary");
const { RATE_SNAPSHOT_ATTRIBUTES } = require("../../utils/bookingRateSnapshot");

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

async function healAgentEarningIfMissing(bookingRow, billing) {
    const stored = parseFloat(billing?.agentEarning || 0);
    if (stored > 0) return stored;
    if (!bookingRow?.zone) return 0;

    try {
        const totals = await invoiceManagementService.calculateInvoiceTotals(
            bookingRow,
            bookingRow.id
        );
        const healed = parseFloat(totals.finalAgentEarningAmount || 0);
        if (healed > 0) {
            await billingDetails.update(
                {
                    agentEarning: healed,
                    zoneAdminCommission: totals.finalZoneAdminCommissionAmount,
                },
                { where: { bookingId: bookingRow.id } }
            );
        }
        return healed;
    } catch (err) {
        console.warn(
            `[agentWallet] Could not heal agentEarning for booking ${bookingRow.id}:`,
            err.message
        );
        return 0;
    }
}

/**
 * Credit agent wallet when booking is fully paid. Idempotent per booking.
 * Cash orders record cash_collected even when commission is still 0, so admin
 * cash-due can show the amount the platform must collect from the shop.
 */
async function creditAgentForPaidBooking(bookingId, options = {}) {
    const bookingRow = await booking.findByPk(bookingId, {
        attributes: [
            "id",
            "orderTrackId",
            "laundryShopId",
            "zoneId",
            "paymentType",
            "paymentConfirmed",
            "balancePaymentMethod",
            "balanceCollectedVia",
            ...RATE_SNAPSHOT_ATTRIBUTES,
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
                    "serviceCharge",
                    "upfrontAmount",
                ],
            },
            {
                model: zone,
                attributes: [
                    "id",
                    "name",
                    "zoneAdminComission",
                    "agentCommissionPercent",
                    "zoneMinimumAmount",
                    "serviceCharge",
                ],
                required: false,
            },
            {
                model: tip,
                as: "tips",
                attributes: ["id", "amount"],
                required: false,
            },
        ],
    });

    if (!bookingRow) {
        return { credited: false, reason: "booking_not_found" };
    }

    const billing = bookingRow.billingDetail;
    const channel = classifyAgentEarningChannel(bookingRow);
    const explicitCashAmount = parseFloat(options.cashCollectedAmount);
    const hasExplicitCash =
        Number.isFinite(explicitCashAmount) && explicitCashAmount > 0;
    const billingPaid = billing?.paymentStatus === "Paid";
    const cashConfirmed =
        channel === "cash" &&
        (Boolean(bookingRow.paymentConfirmed) || hasExplicitCash);

    if (!billingPaid && !cashConfirmed) {
        return { credited: false, reason: "not_paid" };
    }

    if (cashConfirmed && billing && billing.paymentStatus !== "Paid") {
        await billingDetails.update(
            { paymentStatus: "Paid" },
            { where: { bookingId } }
        );
    }

    const agentUserId = await resolveShopOwnerUserId(bookingRow.laundryShopId);
    if (!agentUserId) {
        return { credited: false, reason: "no_shop_owner" };
    }

    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const amountDue = Number(paymentSummary?.amountDueNow ?? 0);
    if (!hasExplicitCash && !cashConfirmed && amountDue > 0.02) {
        return { credited: false, reason: "balance_still_due" };
    }

    const currency = await resolveCurrencyForBooking(bookingRow);
    const orderLabel = bookingRow.orderTrackId || String(bookingId);
    const agentEarning = await healAgentEarningIfMissing(bookingRow, billing);

    let cashRecorded = false;
    if (channel === "cash") {
        const cashCollectedAmount = await resolveCashCollectedAmount(
            bookingId,
            bookingRow,
            options
        );
        if (cashCollectedAmount > 0) {
            const cashResult = await recordCashCollectedForBooking({
                bookingId,
                agentUserId,
                cashCollectedAmount,
                currency,
                orderLabel,
            });
            cashRecorded =
                cashResult.recorded || cashResult.reason === "already_recorded";
        }
    }

    if (await hasCommissionCredit(bookingId)) {
        return {
            credited: false,
            cashRecorded,
            reason: "already_credited",
            agentUserId,
            channel,
        };
    }

    if (!agentEarning || agentEarning <= 0) {
        return {
            credited: false,
            cashRecorded,
            reason: "no_agent_earning",
            agentUserId,
            channel,
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
 * Only counts orders that actually reached payment — matches the wallet
 * ledger (booking_commission is only credited for Paid bookings) and the
 * admin order breakdown, so "Commission earned" / "Payable" never outgrow
 * what the Orders/Ledger tabs can show.
 */
async function sumAgentEarningsBreakdown(laundryShopId) {
    const rows = await billingDetails.findAll({
        where: {
            agentEarning: { [Op.gt]: 0 },
            paymentStatus: "Paid",
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
        if (
            !result.credited &&
            !result.cashRecorded &&
            result.reason &&
            result.reason !== "already_credited"
        ) {
            stats.skipped.push({
                bookingId: row.bookingId,
                orderTrackId: row.booking?.orderTrackId || null,
                reason: result.reason,
            });
        }
    }

    return stats;
}

/**
 * Paid cash bookings that never got a wallet row (new shops, missed credit).
 * Safe to run on the admin cash-due list so settlement appears without a manual sync.
 */
async function backfillMissingCashLedger(options = {}) {
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 200, 1), 500);

    const rows = await booking.findAll({
        where: {
            laundryShopId: { [Op.ne]: null },
            [Op.or]: [
                { paymentType: "cash", paymentConfirmed: true },
                { balanceCollectedVia: "cash" },
            ],
        },
        attributes: ["id", "orderTrackId"],
        order: [["id", "DESC"]],
        limit,
    });

    const stats = {
        processed: 0,
        credited: 0,
        cashRecorded: 0,
        skipped: [],
    };

    for (const row of rows) {
        const hasCash = await hasWalletEntry(
            row.id,
            CASH_COLLECTED_REFERENCE,
            "debit"
        );
        const hasCommission = await hasCommissionCredit(row.id);
        if (hasCash && hasCommission) continue;

        stats.processed += 1;
        const result = await creditAgentForPaidBooking(row.id);
        if (result.credited) stats.credited += 1;
        if (result.cashRecorded) stats.cashRecorded += 1;
        if (
            !result.credited &&
            !result.cashRecorded &&
            result.reason &&
            result.reason !== "already_credited"
        ) {
            stats.skipped.push({
                bookingId: row.id,
                orderTrackId: row.orderTrackId || null,
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

/**
 * Human-readable label for a ledger row, for the admin cash-settlement detail screen.
 */
function describeWalletReferenceType(referenceType, type) {
    switch (referenceType) {
        case CASH_COLLECTED_REFERENCE:
            return "Cash collected from customer";
        case CASH_REMITTED_REFERENCE:
            return "Cash handed to platform";
        case COMMISSION_REFERENCE:
            return "Commission earned";
        case ADMIN_SETTLEMENT_REFERENCE:
            return type === "debit" ? "Admin adjustment (debit)" : "Admin adjustment (credit)";
        case AGENT_PAYOUT_REFERENCE:
            return "Payout released to agent";
        case WITHDRAWAL_REFERENCE:
            return "Agent withdrawal";
        case PAYOUT_REFERENCE:
            return "Legacy payout";
        default:
            return referenceType || "Wallet entry";
    }
}

/**
 * Full, unfiltered chronological ledger for one agent — every wallet row
 * (cash collected, cash remitted, commission, admin adjustment, payout,
 * withdrawal). Used by the admin cash-settlement detail screen so nothing
 * is hidden behind the aggregate summary numbers.
 */
async function listAdminSettlementLedger(agentUserId, options = {}) {
    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 200);
    const offset = (page - 1) * limit;

    const { count, rows } = await wallet.findAndCountAll({
        where: { userId: agentUserId },
        order: [
            ["createdAt", "DESC"],
            ["id", "DESC"],
        ],
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
        transactions: rows.map((row) => {
            const plain = row.get({ plain: true });
            return {
                id: plain.id,
                amount: parseFloat(plain.amount || 0),
                currency: plain.currency,
                type: plain.type,
                status: plain.status,
                description: plain.description,
                bookingId: plain.bookingId,
                orderTrackId: plain.booking?.orderTrackId || null,
                referenceType: plain.referenceType,
                label: describeWalletReferenceType(plain.referenceType, plain.type),
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

/**
 * Per-order breakdown for one agent: which completed/paid orders contributed
 * to cash collected and commission earned, cross-referenced against the
 * actual wallet ledger rows (not re-derived) so the admin detail screen
 * always matches the summary numbers exactly.
 */
async function listAgentOrderBreakdown(agentUserId, options = {}) {
    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const shop = await addressDb.findOne({
        where: { userId: agentUserId, addressType: "LaundaryShopAddress" },
        attributes: ["id"],
    });
    if (!shop) {
        throw new NotFoundError("Agent shop address not found");
    }

    const { count, rows } = await billingDetails.findAndCountAll({
        where: { paymentStatus: "Paid" },
        include: [
            {
                model: booking,
                as: "booking",
                required: true,
                where: { laundryShopId: shop.id },
                attributes: [
                    "id",
                    "orderTrackId",
                    "paymentType",
                    "balanceCollectedVia",
                    "balancePaymentMethod",
                    "pickupCompletedAt",
                    "deliveryCompletedAt",
                    "createdAt",
                ],
            },
        ],
        attributes: [
            "bookingId",
            "agentEarning",
            "zoneAdminCommission",
            "total",
            "serviceCharge",
            "upfrontAmount",
            "discount",
            "updatedAt",
        ],
        order: [
            [{ model: booking, as: "booking" }, "deliveryCompletedAt", "DESC"],
            ["updatedAt", "DESC"],
        ],
        limit,
        offset,
        distinct: true,
    });

    const bookingIds = rows.map((r) => r.bookingId).filter(Boolean);
    const walletRows = bookingIds.length
        ? await wallet.findAll({
              where: {
                  bookingId: { [Op.in]: bookingIds },
                  referenceType: {
                      [Op.in]: [CASH_COLLECTED_REFERENCE, COMMISSION_REFERENCE],
                  },
                  status: "completed",
              },
              attributes: ["bookingId", "referenceType", "amount", "createdAt"],
              raw: true,
          })
        : [];

    const walletByBooking = new Map();
    for (const row of walletRows) {
        if (!walletByBooking.has(row.bookingId)) {
            walletByBooking.set(row.bookingId, {});
        }
        walletByBooking.get(row.bookingId)[row.referenceType] = row;
    }

    const orders = rows.map((row) => {
        const plain = row.get({ plain: true });
        const bookingRow = plain.booking || {};
        const channel = classifyAgentEarningChannel(bookingRow);
        const ledger = walletByBooking.get(plain.bookingId) || {};
        const cashEntry = ledger[CASH_COLLECTED_REFERENCE];
        const commissionEntry = ledger[COMMISSION_REFERENCE];
        const orderTotal = parseFloat(plain.total || 0);

        return {
            bookingId: plain.bookingId,
            orderTrackId: bookingRow.orderTrackId || String(plain.bookingId),
            paymentType: bookingRow.paymentType || null,
            channel,
            completedAt:
                bookingRow.deliveryCompletedAt ||
                bookingRow.pickupCompletedAt ||
                plain.updatedAt,
            orderTotal,
            commissionAmount: commissionEntry
                ? parseFloat(commissionEntry.amount || 0)
                : parseFloat(plain.agentEarning || 0),
            commissionCreditedAt: commissionEntry ? commissionEntry.createdAt : null,
            cashCollectedAmount: cashEntry
                ? parseFloat(cashEntry.amount || 0)
                : channel === "cash"
                  ? orderTotal
                  : 0,
            cashRecordedAt: cashEntry ? cashEntry.createdAt : null,
        };
    });

    const totalPages = count > 0 ? Math.ceil(count / limit) : 0;

    return {
        orders,
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
    backfillMissingCashLedger,
    hasSettlementActivity,
    getWalletSummary,
    getWalletTransactions,
    listAdminSettlementLedger,
    listAgentOrderBreakdown,
    hasCommissionCredit,
    resolveShopOwnerUserId,
};

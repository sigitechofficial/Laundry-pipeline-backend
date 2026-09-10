const {
    booking,
    billingDetails,
    addressDb,
    bussinessInformation,
    wallet,
    units,
    zone,
    tip,
    bookingRefund,
} = require("../../models");
const {
    bookingTipAmountFromTips,
    extraTipAmountFromTips,
} = require("../../utils/bookingTips");
const { Op } = require("sequelize");
const { NotFoundError } = require("../../middlewares/universalErrorHandler");
const invoiceManagementService = require("./invoiceManagementService");
const { normalizePaymentType } = require("../../utils/invoicePaymentSummary");
const { RATE_SNAPSHOT_ATTRIBUTES } = require("../../utils/bookingRateSnapshot");
const { netAgentEarning } = require("../../utils/agentEarningNet");
const { REFUNDED } = require("../../constants/bookingStatusIds");

const COMMISSION_REFERENCE = "booking_commission";
const COMMISSION_CLAWBACK_REFERENCE = "commission_clawback";
const CASH_COLLECTED_REFERENCE = "cash_collected";
const CASH_REFUNDED_REFERENCE = "cash_refunded";
const CASH_REMITTED_REFERENCE = "cash_remitted";
const ADMIN_SETTLEMENT_REFERENCE = "admin_settlement";
const PAYOUT_REFERENCE = "payout";
// Credit created when an admin pays out (releases) the agent's earnings into the
// agent's withdrawable wallet. This is the ONLY thing the agent sees as their
// wallet "Credit" / available balance. Order commissions are tracked separately
// as earnings and are NOT shown as wallet credit until an admin pays out.
const AGENT_PAYOUT_REFERENCE = "agent_payout";
const EXTRA_TIP_REFERENCE = "extra_tip";
const EXTRA_TIP_CLAWBACK_REFERENCE = "extra_tip_clawback";
// Debit when an agent requests / completes a withdrawal to Stripe Connect.
const WITHDRAWAL_REFERENCE = "agent_withdrawal";
const CUSTOMER_REFUND_REFERENCE = "customer_refund";
const DEFAULT_CURRENCY = "GBP";
const MIN_WITHDRAWAL_AMOUNT = 1;

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

async function sumBookingWalletByType(bookingId, referenceType, type) {
    const rows = await wallet.findAll({
        where: {
            bookingId,
            referenceType,
            type,
            status: "completed",
        },
        attributes: ["amount"],
        raw: true,
    });
    return rows.reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
}

/** Net commission still credited for this booking (credits − clawbacks). */
async function getNetCommissionForBooking(bookingId) {
    const credited = await sumBookingWalletByType(
        bookingId,
        COMMISSION_REFERENCE,
        "credit"
    );
    const clawed = await sumBookingWalletByType(
        bookingId,
        COMMISSION_CLAWBACK_REFERENCE,
        "debit"
    );
    return parseFloat(Math.max(0, credited - clawed).toFixed(2));
}

async function getNetCashCollectedForBooking(bookingId) {
    const collected = await sumBookingWalletByType(
        bookingId,
        CASH_COLLECTED_REFERENCE,
        "debit"
    );
    const refunded = await sumBookingWalletByType(
        bookingId,
        CASH_REFUNDED_REFERENCE,
        "credit"
    );
    return parseFloat(Math.max(0, collected - refunded).toFixed(2));
}

async function getNetExtraTipForBooking(bookingId) {
    const credited = await sumBookingWalletByType(
        bookingId,
        EXTRA_TIP_REFERENCE,
        "credit"
    );
    const clawed = await sumBookingWalletByType(
        bookingId,
        EXTRA_TIP_CLAWBACK_REFERENCE,
        "debit"
    );
    return parseFloat(Math.max(0, credited - clawed).toFixed(2));
}

/**
 * Reverse agent commission for an admin refund (settlement debit).
 * Idempotent via unique description key when provided.
 */
async function clawbackCommissionForRefund({
    bookingId,
    agentUserId,
    amount,
    currency = "GBP",
    orderLabel,
    refundId,
}) {
    const claw = parseFloat(amount || 0);
    if (!(claw > 0) || !agentUserId) {
        return { recorded: false, amount: 0, reason: "noop" };
    }
    const net = await getNetCommissionForBooking(bookingId);
    const apply = parseFloat(Math.min(claw, net).toFixed(2));
    if (apply <= 0) {
        return { recorded: false, amount: 0, reason: "nothing_to_clawback" };
    }

    const description = `Commission clawback for refund #${refundId || "pending"} on order #${orderLabel || bookingId}`;
    if (refundId) {
        const existing = await wallet.findOne({
            where: {
                bookingId,
                userId: agentUserId,
                referenceType: COMMISSION_CLAWBACK_REFERENCE,
                type: "debit",
                description,
            },
            attributes: ["id", "amount"],
        });
        if (existing) {
            return {
                recorded: false,
                amount: parseFloat(existing.amount || 0),
                reason: "already_recorded",
                walletId: existing.id,
            };
        }
    }

    const row = await wallet.create({
        userId: agentUserId,
        bookingId,
        referenceType: COMMISSION_CLAWBACK_REFERENCE,
        amount: apply,
        type: "debit",
        description,
        currency,
        status: "completed",
    });
    return { recorded: true, amount: apply, walletId: row.id };
}

/** Reduce cash_collected impact so cash-due drops after cash refund to customer. */
async function reverseCashCollectedForRefund({
    bookingId,
    agentUserId,
    amount,
    currency = "GBP",
    orderLabel,
    refundId,
}) {
    const claw = parseFloat(amount || 0);
    if (!(claw > 0) || !agentUserId) {
        return { recorded: false, amount: 0, reason: "noop" };
    }
    const net = await getNetCashCollectedForBooking(bookingId);
    const apply = parseFloat(Math.min(claw, net).toFixed(2));
    if (apply <= 0) {
        return { recorded: false, amount: 0, reason: "nothing_to_reverse" };
    }

    const description = `Cash refunded to customer for refund #${refundId || "pending"} on order #${orderLabel || bookingId}`;
    if (refundId) {
        const existing = await wallet.findOne({
            where: {
                bookingId,
                userId: agentUserId,
                referenceType: CASH_REFUNDED_REFERENCE,
                type: "credit",
                description,
            },
            attributes: ["id", "amount"],
        });
        if (existing) {
            return {
                recorded: false,
                amount: parseFloat(existing.amount || 0),
                reason: "already_recorded",
                walletId: existing.id,
            };
        }
    }

    const row = await wallet.create({
        userId: agentUserId,
        bookingId,
        referenceType: CASH_REFUNDED_REFERENCE,
        amount: apply,
        type: "credit",
        description,
        currency,
        status: "completed",
    });
    return { recorded: true, amount: apply, walletId: row.id };
}

async function clawbackExtraTipForRefund({
    bookingId,
    agentUserId,
    amount,
    currency = "GBP",
    orderLabel,
    refundId,
}) {
    const claw = parseFloat(amount || 0);
    if (!(claw > 0) || !agentUserId) {
        return { recorded: false, amount: 0, reason: "noop" };
    }
    const net = await getNetExtraTipForBooking(bookingId);
    const apply = parseFloat(Math.min(claw, net).toFixed(2));
    if (apply <= 0) {
        return { recorded: false, amount: 0, reason: "nothing_to_clawback" };
    }

    const description = `Extra tip clawback for refund #${refundId || "pending"} on order #${orderLabel || bookingId}`;
    if (refundId) {
        const existing = await wallet.findOne({
            where: {
                bookingId,
                userId: agentUserId,
                referenceType: EXTRA_TIP_CLAWBACK_REFERENCE,
                type: "debit",
                description,
            },
            attributes: ["id", "amount"],
        });
        if (existing) {
            return {
                recorded: false,
                amount: parseFloat(existing.amount || 0),
                reason: "already_recorded",
                walletId: existing.id,
            };
        }
    }

    const row = await wallet.create({
        userId: agentUserId,
        bookingId,
        referenceType: EXTRA_TIP_CLAWBACK_REFERENCE,
        amount: apply,
        type: "debit",
        description,
        currency,
        status: "completed",
    });
    return { recorded: true, amount: apply, walletId: row.id };
}

async function latestWalletCreatedAt(userId, referenceType) {
    const row = await wallet.findOne({
        where: {
            userId,
            referenceType,
            status: "completed",
        },
        order: [
            ["createdAt", "DESC"],
            ["id", "DESC"],
        ],
        attributes: ["createdAt"],
    });
    return row?.createdAt || null;
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

async function bookingHasCustomerRefund(bookingId) {
    if (!bookingId) return false;
    const n = await bookingRefund.count({
        where: {
            bookingId,
            status: { [Op.in]: ["succeeded", "partial_failed"] },
        },
    });
    return n > 0;
}

async function getCommissionLedgerByBookingIds(bookingIds) {
    const ids = [
        ...new Set(
            (bookingIds || []).map((id) => Number(id)).filter((id) => id > 0)
        ),
    ];
    const out = new Map();
    if (!ids.length) return out;

    const rows = await wallet.findAll({
        where: {
            bookingId: { [Op.in]: ids },
            status: "completed",
            referenceType: {
                [Op.in]: [COMMISSION_REFERENCE, COMMISSION_CLAWBACK_REFERENCE],
            },
        },
        attributes: ["bookingId", "referenceType", "type", "amount"],
        raw: true,
    });

    for (const row of rows) {
        const bookingId = Number(row.bookingId);
        const prev = out.get(bookingId) || { credited: 0, clawed: 0 };
        const amount = parseFloat(row.amount || 0);
        if (row.referenceType === COMMISSION_REFERENCE && row.type === "credit") {
            prev.credited += amount;
        }
        if (
            row.referenceType === COMMISSION_CLAWBACK_REFERENCE &&
            row.type === "debit"
        ) {
            prev.clawed += amount;
        }
        out.set(bookingId, prev);
    }
    return out;
}

async function healAgentEarningIfMissing(bookingRow, billing) {
    const stored = parseFloat(billing?.agentEarning || 0);
    if (stored > 0) return stored;
    if (Number(bookingRow?.bookingStatusId) === REFUNDED) return 0;
    if (await bookingHasCustomerRefund(bookingRow?.id)) return 0;
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
            "bookingStatusId",
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

    if (Number(bookingRow.bookingStatusId) === REFUNDED) {
        return { credited: false, reason: "refunded" };
    }
    if (await bookingHasCustomerRefund(bookingId)) {
        if (await hasCommissionCredit(bookingId)) {
            return { credited: false, reason: "already_credited" };
        }
        return { credited: false, reason: "refunded" };
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
 * 100% of a post-complete extra tip goes to the shop owner.
 * Card charge hits the platform Stripe account, so this is a payable
 * credit — it must NOT change cash-due (excluded from settlementCredits).
 */
async function creditExtraTipForBooking({ bookingId, amount, tipId } = {}) {
    const tipAmount = parseFloat(amount || 0);
    if (!bookingId || !Number.isFinite(tipAmount) || tipAmount <= 0) {
        return { credited: false, reason: "invalid_amount" };
    }

    if (await hasWalletEntry(bookingId, EXTRA_TIP_REFERENCE, "credit")) {
        return { credited: false, reason: "already_credited" };
    }

    const bookingRow = await booking.findByPk(bookingId, {
        attributes: ["id", "orderTrackId", "laundryShopId"],
    });
    if (!bookingRow) {
        return { credited: false, reason: "booking_not_found" };
    }

    const agentUserId = await resolveShopOwnerUserId(bookingRow.laundryShopId);
    if (!agentUserId) {
        return { credited: false, reason: "no_shop_owner" };
    }

    const currency = await resolveCurrencyForBooking(bookingRow);
    const orderLabel = bookingRow.orderTrackId || bookingRow.id;
    const entry = await wallet.create({
        userId: agentUserId,
        bookingId,
        referenceType: EXTRA_TIP_REFERENCE,
        amount: parseFloat(tipAmount.toFixed(2)),
        currency,
        type: "credit",
        status: "completed",
        description: `Extra tip after delivery for order #${orderLabel}${
            tipId ? ` (tip ${tipId})` : ""
        }`,
    });

    return {
        credited: true,
        amount: parseFloat(tipAmount.toFixed(2)),
        walletId: entry.id,
        agentUserId,
    };
}

/**
 * Lifetime agent commission, split by collection channel.
 * Wallet credits − clawbacks are the source of truth so a full customer
 * refund zeros payable even if billingDetails.agentEarning was never rewritten.
 * Fully refunded bookings (status 21) never count, regardless of ledger drift.
 */
async function sumAgentEarningsBreakdown(laundryShopId) {
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
                attributes: [
                    "id",
                    "bookingStatusId",
                    "paymentType",
                    "balancePaymentMethod",
                    "balanceCollectedVia",
                ],
                where: { laundryShopId },
            },
        ],
    });

    const ledger = await getCommissionLedgerByBookingIds(
        rows.map((row) => row.bookingId || row.booking?.id)
    );

    let total = 0;
    let cash = 0;
    let card = 0;

    for (const row of rows) {
        if (Number(row.booking?.bookingStatusId) === REFUNDED) continue;

        const bookingId = Number(row.bookingId || row.booking?.id);
        const led = ledger.get(bookingId) || { credited: 0, clawed: 0 };
        const amount = netAgentEarning({
            billed: row.agentEarning,
            credited: led.credited,
            clawed: led.clawed,
        });
        if (amount <= 0.009) continue;

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
    const extraTipCredits = await sumWalletAmount(agentUserId, "credit", {
        referenceType: EXTRA_TIP_REFERENCE,
    });
    const extraTipClawbacks = await sumWalletAmount(agentUserId, "debit", {
        referenceType: EXTRA_TIP_CLAWBACK_REFERENCE,
    });
    const netExtraTips = parseFloat(
        Math.max(0, extraTipCredits - extraTipClawbacks).toFixed(2)
    );

    // cash_refunded credits stay in settlementCredits (reduce cash due).
    // extra_tip (+ clawback) stay off cash-due and on payable instead.
    const settlementCredits =
        totalCreditedAll - agentPayoutCredits - extraTipCredits;
    const settlementDebits =
        totalDebitedAll - totalPayouts - totalWithdrawn - extraTipClawbacks;
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
    // Extra post-complete tips are card credits the platform holds.
    // They increase payable, but must not inflate "commission earned"
    // (that figure offsets cash due).
    const totalEarningCard = parseFloat(
        (earnings.totalEarningCard + netExtraTips).toFixed(2)
    );
    const totalEarning = parseFloat(earnings.totalEarning.toFixed(2));

    const platformOwesAgent = parseFloat(
        Math.max(totalEarningCard - agentPayoutCredits, 0).toFixed(2)
    );

    const totalCashRefunded = await sumWalletAmount(agentUserId, "credit", {
        referenceType: CASH_REFUNDED_REFERENCE,
    });
    const totalCommissionCredits = await sumWalletAmount(agentUserId, "credit", {
        referenceType: COMMISSION_REFERENCE,
    });
    const totalCommissionClawback = await sumWalletAmount(agentUserId, "debit", {
        referenceType: COMMISSION_CLAWBACK_REFERENCE,
    });
    const adminAdjustmentDebits = await sumWalletAmount(agentUserId, "debit", {
        referenceType: ADMIN_SETTLEMENT_REFERENCE,
    });
    const netCommissionOffset = parseFloat(
        Math.max(0, totalCommissionCredits - totalCommissionClawback).toFixed(2)
    );
    const adminAdjustmentNet = parseFloat(
        (totalAdminSettlements - adminAdjustmentDebits).toFixed(2)
    );
    const cashInTill = parseFloat(
        Math.max(
            0,
            totalCashCollected - totalCashRefunded - totalCashRemitted
        ).toFixed(2)
    );
    const cashRemainingAfterPending = parseFloat(
        Math.max(cashDueToPlatform - pendingCashRemitted, 0).toFixed(2)
    );
    const commissionCardOnly = parseFloat(earnings.totalEarningCard.toFixed(2));
    const [lastCashRemittedAt, lastPayoutAt] = await Promise.all([
        latestWalletCreatedAt(agentUserId, CASH_REMITTED_REFERENCE),
        latestWalletCreatedAt(agentUserId, AGENT_PAYOUT_REFERENCE),
    ]);

    return {
        balance,
        currency,
        netSettlement: balance,
        cashDueToPlatform,
        platformOwesAgent,
        availableBalance,
        totalEarning,
        totalEarningCash: earnings.totalEarningCash,
        totalEarningCard,
        totalExtraTips: netExtraTips,
        totalCashCollected: parseFloat(totalCashCollected.toFixed(2)),
        totalCashRemitted: parseFloat(totalCashRemitted.toFixed(2)),
        pendingCashRemittance: parseFloat(pendingCashRemitted.toFixed(2)),
        totalAdminSettlements: parseFloat(totalAdminSettlements.toFixed(2)),
        totalPayouts: parseFloat(totalPayouts.toFixed(2)),
        totalAgentPayouts: walletCredit,
        totalWithdrawn: parseFloat(totalWithdrawn.toFixed(2)),
        pendingWithdrawals: parseFloat(pendingWithdrawals.toFixed(2)),
        connectAccountConnected,
        canWithdraw: availableBalance >= MIN_WITHDRAWAL_AMOUNT,
        canRequestWithdrawal: availableBalance >= MIN_WITHDRAWAL_AMOUNT,
        payoutAccountReady: connectAccountConnected,
        minimumWithdrawal: MIN_WITHDRAWAL_AMOUNT,
        // Agent-facing "Credit" = money released to the agent via admin payout
        // (0 until an admin pays out). Order commissions are NOT counted here.
        totalCredited: walletCredit,
        // Agent-facing "Debited" = withdrawals only (0 until they withdraw).
        totalDebited: parseFloat(totalWithdrawn.toFixed(2)),
        commissionCreditCount: commissionCredits,
        totalCashRefunded: parseFloat(totalCashRefunded.toFixed(2)),
        totalCommissionClawback: parseFloat(totalCommissionClawback.toFixed(2)),
        totalExtraTipClawback: parseFloat(extraTipClawbacks.toFixed(2)),
        cashRemainingAfterPending,
        commissionCardOnly,
        lastCashRemittedAt,
        lastPayoutAt,
        rails: {
            cashFromAgent: {
                collected: parseFloat(totalCashCollected.toFixed(2)),
                refundedToCustomers: parseFloat(totalCashRefunded.toFixed(2)),
                commissionOffset: netCommissionOffset,
                commissionCredited: parseFloat(totalCommissionCredits.toFixed(2)),
                commissionClawedBack: parseFloat(totalCommissionClawback.toFixed(2)),
                remitted: parseFloat(totalCashRemitted.toFixed(2)),
                pendingRemittance: parseFloat(pendingCashRemitted.toFixed(2)),
                adminAdjustmentNet,
                cashInTill,
                stillDue: cashDueToPlatform,
                stillDueAfterPending: cashRemainingAfterPending,
                lastRemittedAt: lastCashRemittedAt,
            },
            payableToAgent: {
                cardCommission: commissionCardOnly,
                extraTips: netExtraTips,
                extraTipClawbacks: parseFloat(extraTipClawbacks.toFixed(2)),
                releasedToWallet: walletCredit,
                stillOwed: platformOwesAgent,
                withdrawnToBank: parseFloat(totalWithdrawn.toFixed(2)),
                pendingWithdrawals: parseFloat(pendingWithdrawals.toFixed(2)),
                sittingInWallet: availableBalance,
                lastReleasedAt: lastPayoutAt,
            },
            refunds: {
                commissionClawback: parseFloat(totalCommissionClawback.toFixed(2)),
                cashReturnedToCustomer: parseFloat(totalCashRefunded.toFixed(2)),
                extraTipClawback: parseFloat(extraTipClawbacks.toFixed(2)),
            },
        },
    };
}

function hasSettlementActivity(summary) {
    if (!summary) return false;
    return (
        summary.cashDueToPlatform > 0 ||
        summary.pendingCashRemittance > 0 ||
        summary.platformOwesAgent > 0 ||
        summary.totalCashCollected > 0 ||
        summary.totalCashRemitted > 0 ||
        summary.totalAgentPayouts > 0 ||
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
        canRequestWithdrawal: summary.canRequestWithdrawal,
        payoutAccountReady: summary.payoutAccountReady,
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
        case CASH_REFUNDED_REFERENCE:
            return "Cash returned to customer (refund)";
        case CASH_REMITTED_REFERENCE:
            return "Cash handed to platform";
        case COMMISSION_REFERENCE:
            return "Commission earned";
        case COMMISSION_CLAWBACK_REFERENCE:
            return "Commission clawed back (refund)";
        case ADMIN_SETTLEMENT_REFERENCE:
            return type === "debit" ? "Admin adjustment (debit)" : "Admin adjustment (credit)";
        case AGENT_PAYOUT_REFERENCE:
            return "Payout released to agent wallet";
        case WITHDRAWAL_REFERENCE:
            return "Withdrawn to agent's bank (Stripe)";
        case PAYOUT_REFERENCE:
            return "Legacy payout";
        case EXTRA_TIP_REFERENCE:
            return "Extra tip after delivery";
        case EXTRA_TIP_CLAWBACK_REFERENCE:
            return "Extra tip clawed back (refund)";
        case CUSTOMER_REFUND_REFERENCE:
            return "Customer refund audit";
        default:
            return referenceType || "Wallet entry";
    }
}

const LEDGER_RAILS = {
    cash: [
        CASH_COLLECTED_REFERENCE,
        CASH_REFUNDED_REFERENCE,
        CASH_REMITTED_REFERENCE,
        COMMISSION_REFERENCE,
        ADMIN_SETTLEMENT_REFERENCE,
    ],
    payable: [
        AGENT_PAYOUT_REFERENCE,
        EXTRA_TIP_REFERENCE,
        EXTRA_TIP_CLAWBACK_REFERENCE,
        WITHDRAWAL_REFERENCE,
        PAYOUT_REFERENCE,
    ],
    refunds: [
        COMMISSION_CLAWBACK_REFERENCE,
        CASH_REFUNDED_REFERENCE,
        EXTRA_TIP_CLAWBACK_REFERENCE,
        CUSTOMER_REFUND_REFERENCE,
    ],
};

/** Types that drive getWalletSummary().balance (cash-due settlement rail). */
function affectsSettlementBalance(referenceType) {
    return (
        referenceType !== AGENT_PAYOUT_REFERENCE &&
        referenceType !== EXTRA_TIP_REFERENCE &&
        referenceType !== EXTRA_TIP_CLAWBACK_REFERENCE &&
        referenceType !== WITHDRAWAL_REFERENCE &&
        referenceType !== PAYOUT_REFERENCE
    );
}

/** Types that drive available wallet (payouts in, withdrawals out). */
function affectsWalletBalance(referenceType) {
    return (
        referenceType === AGENT_PAYOUT_REFERENCE ||
        referenceType === WITHDRAWAL_REFERENCE
    );
}

function signedSettlementDelta(row) {
    if (row.status !== "completed" || !affectsSettlementBalance(row.referenceType)) {
        return 0;
    }
    const amount = parseFloat(row.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) return 0;
    return row.type === "credit" ? amount : -amount;
}

function signedWalletDelta(row) {
    if (row.status !== "completed" || !affectsWalletBalance(row.referenceType)) {
        return 0;
    }
    const amount = parseFloat(row.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) return 0;
    // Payout credit raises available; withdrawal debit lowers it.
    if (row.referenceType === AGENT_PAYOUT_REFERENCE && row.type === "credit") {
        return amount;
    }
    if (row.referenceType === WITHDRAWAL_REFERENCE && row.type === "debit") {
        return -amount;
    }
    return 0;
}

function moneyInOut(row) {
    const amount = parseFloat(row.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
        return { moneyIn: 0, moneyOut: 0 };
    }
    if (row.type === "credit") {
        return { moneyIn: amount, moneyOut: 0 };
    }
    return { moneyIn: 0, moneyOut: amount };
}

/**
 * Full chronological ledger for one agent — every wallet row with bank-statement
 * running balances (settlement rail + withdrawable wallet). Pagination is newest
 * first; balances are computed oldest→newest so each row has before/after.
 */
async function listAdminSettlementLedger(agentUserId, options = {}) {
    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 200);
    const offset = (page - 1) * limit;
    const where = { userId: agentUserId };
    const railTypes = LEDGER_RAILS[String(options.rail || "").toLowerCase()];
    if (options.referenceType) {
        where.referenceType = options.referenceType;
    } else if (railTypes) {
        where.referenceType = { [Op.in]: railTypes };
    }

    const rowsAsc = await wallet.findAll({
        where,
        order: [
            ["createdAt", "ASC"],
            ["id", "ASC"],
        ],
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

    let settlementRunning = 0;
    let walletRunning = 0;
    let paymentsReceived = 0;
    let withdrawalsTotal = 0;
    let cashCollectedTotal = 0;

    const enrichedAsc = rowsAsc.map((row) => {
        const plain = row.get({ plain: true });
        const settlementBefore = parseFloat(settlementRunning.toFixed(2));
        const walletBefore = parseFloat(walletRunning.toFixed(2));
        settlementRunning = parseFloat(
            (settlementRunning + signedSettlementDelta(plain)).toFixed(2)
        );
        walletRunning = parseFloat((walletRunning + signedWalletDelta(plain)).toFixed(2));
        const { moneyIn, moneyOut } = moneyInOut(plain);

        if (plain.status === "completed") {
            if (plain.referenceType === CASH_REMITTED_REFERENCE && plain.type === "credit") {
                paymentsReceived = parseFloat((paymentsReceived + moneyIn).toFixed(2));
            }
            if (plain.referenceType === WITHDRAWAL_REFERENCE && plain.type === "debit") {
                withdrawalsTotal = parseFloat((withdrawalsTotal + moneyOut).toFixed(2));
            }
            if (plain.referenceType === CASH_COLLECTED_REFERENCE && plain.type === "debit") {
                cashCollectedTotal = parseFloat((cashCollectedTotal + moneyOut).toFixed(2));
            }
        }

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
            stripeTransferId: plain.stripeTransferId || null,
            failureReason: plain.failureReason || null,
            createdAt: plain.createdAt,
            moneyIn,
            moneyOut,
            settlementBalanceBefore: settlementBefore,
            settlementBalanceAfter: parseFloat(settlementRunning.toFixed(2)),
            walletBalanceBefore: walletBefore,
            walletBalanceAfter: parseFloat(walletRunning.toFixed(2)),
            // Primary statement balance = settlement rail (cash due when negative).
            balanceBefore: settlementBefore,
            balanceAfter: parseFloat(settlementRunning.toFixed(2)),
        };
    });

    const count = enrichedAsc.length;
    const totalPages = count > 0 ? Math.ceil(count / limit) : 0;
    // Newest first for the admin table; balances already attached.
    const transactions = enrichedAsc.slice().reverse().slice(offset, offset + limit);
    const oldestOnPage = transactions.length
        ? transactions[transactions.length - 1]
        : null;
    const newestOnPage = transactions.length ? transactions[0] : null;

    return {
        transactions,
        pagination: {
            page,
            limit,
            total: count,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
        },
        statement: {
            currency: enrichedAsc[0]?.currency || DEFAULT_CURRENCY,
            openingBalance: oldestOnPage ? oldestOnPage.balanceBefore : 0,
            closingBalance: newestOnPage
                ? newestOnPage.balanceAfter
                : parseFloat(settlementRunning.toFixed(2)),
            lifetimeSettlementBalance: parseFloat(settlementRunning.toFixed(2)),
            lifetimeWalletBalance: parseFloat(walletRunning.toFixed(2)),
            paymentsReceived,
            withdrawals: withdrawalsTotal,
            cashCollectedFromCustomers: cashCollectedTotal,
            note:
                "Settlement balance: negative = cash due to platform, positive = agent ahead on the cash rail. Wallet balance tracks admin payouts minus Stripe withdrawals.",
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

    // Query from bookings so ORDER BY is on the primary table. Nested
    // billingDetails + tips + DISTINCT blows up on MySQL ONLY_FULL_GROUP_BY
    // and blanks the admin cash-settlement detail page.
    const { count, rows } = await booking.findAndCountAll({
        where: { laundryShopId: shop.id },
        include: [
            {
                model: billingDetails,
                as: "billingDetail",
                required: true,
                where: { paymentStatus: "Paid" },
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
            },
        ],
        attributes: [
            "id",
            "orderTrackId",
            "bookingStatusId",
            "paymentType",
            "balanceCollectedVia",
            "balancePaymentMethod",
            "pickupCompletedAt",
            "deliveryCompletedAt",
            "createdAt",
        ],
        order: [
            ["deliveryCompletedAt", "DESC"],
            ["id", "DESC"],
        ],
        limit,
        offset,
        distinct: true,
        col: "id",
    });

    const bookingIds = rows.map((r) => r.id).filter(Boolean);
    const tipRows = bookingIds.length
        ? await tip.findAll({
              where: { bookingId: { [Op.in]: bookingIds } },
              attributes: ["id", "bookingId", "amount", "source"],
          })
        : [];
    const tipsByBooking = new Map();
    for (const tipRow of tipRows) {
        const bid = tipRow.bookingId;
        if (!tipsByBooking.has(bid)) tipsByBooking.set(bid, []);
        tipsByBooking.get(bid).push(tipRow);
    }
    const walletRows = bookingIds.length
        ? await wallet.findAll({
              where: {
                  bookingId: { [Op.in]: bookingIds },
                  referenceType: {
                      [Op.in]: [
                          CASH_COLLECTED_REFERENCE,
                          CASH_REFUNDED_REFERENCE,
                          COMMISSION_REFERENCE,
                          COMMISSION_CLAWBACK_REFERENCE,
                          EXTRA_TIP_REFERENCE,
                          EXTRA_TIP_CLAWBACK_REFERENCE,
                      ],
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
            walletByBooking.set(row.bookingId, { amounts: {}, dates: {} });
        }
        const bucket = walletByBooking.get(row.bookingId);
        const amount = parseFloat(row.amount || 0);
        bucket.amounts[row.referenceType] =
            (bucket.amounts[row.referenceType] || 0) + amount;
        if (!bucket.dates[row.referenceType]) {
            bucket.dates[row.referenceType] = row.createdAt;
        }
    }

    const orders = rows.map((row) => {
        const bookingRow = row.get({ plain: true });
        const billing = bookingRow.billingDetail || {};
        const bookingTips = tipsByBooking.get(bookingRow.id) || [];
        const channel = classifyAgentEarningChannel(bookingRow);
        const ledger = walletByBooking.get(bookingRow.id) || {
            amounts: {},
            dates: {},
        };
        const amounts = ledger.amounts;
        const dates = ledger.dates;
        const orderTotal = parseFloat(billing.total || 0);
        const bookingTip = bookingTipAmountFromTips(bookingTips);
        const extraTipFromTips = extraTipAmountFromTips(bookingTips);
        const serviceFee = parseFloat(billing.serviceCharge || 0);
        const platformShare = parseFloat(billing.zoneAdminCommission || 0);
        const commissionClawbackAmount = parseFloat(
            (amounts[COMMISSION_CLAWBACK_REFERENCE] || 0).toFixed(2)
        );
        const commissionNet = netAgentEarning({
            billed: billing.agentEarning,
            credited: amounts[COMMISSION_REFERENCE] || 0,
            clawed: commissionClawbackAmount,
        });
        const isFullyRefunded =
            Number(bookingRow.bookingStatusId) === REFUNDED ||
            (commissionClawbackAmount > 0.009 && commissionNet <= 0.009);
        const commissionAmount = amounts[COMMISSION_REFERENCE]
            ? parseFloat(amounts[COMMISSION_REFERENCE].toFixed(2))
            : parseFloat(billing.agentEarning || 0);
        const effectiveCommissionNet = isFullyRefunded ? 0 : commissionNet;
        const laundryCommission = parseFloat(
            Math.max(0, commissionAmount - bookingTip).toFixed(2)
        );
        const cashRefundedAmount = parseFloat(
            (amounts[CASH_REFUNDED_REFERENCE] || 0).toFixed(2)
        );
        const extraTipAmount = amounts[EXTRA_TIP_REFERENCE]
            ? parseFloat(amounts[EXTRA_TIP_REFERENCE].toFixed(2))
            : extraTipFromTips;
        const extraTipClawbackAmount = parseFloat(
            (amounts[EXTRA_TIP_CLAWBACK_REFERENCE] || 0).toFixed(2)
        );
        const cashCollectedAmount = amounts[CASH_COLLECTED_REFERENCE]
            ? parseFloat(amounts[CASH_COLLECTED_REFERENCE].toFixed(2))
            : channel === "cash"
              ? orderTotal
              : 0;

        return {
            bookingId: bookingRow.id,
            orderTrackId: bookingRow.orderTrackId || String(bookingRow.id),
            paymentType: bookingRow.paymentType || null,
            channel,
            completedAt:
                bookingRow.deliveryCompletedAt ||
                bookingRow.pickupCompletedAt ||
                billing.updatedAt,
            orderTotal,
            serviceFee,
            platformShare,
            bookingTip,
            laundryCommission,
            commissionAmount,
            commissionNet: effectiveCommissionNet,
            isFullyRefunded,
            bookingStatusId: bookingRow.bookingStatusId,
            commissionCreditedAt: dates[COMMISSION_REFERENCE] || null,
            extraTipAmount,
            extraTipNet: isFullyRefunded
                ? 0
                : parseFloat(
                      Math.max(0, extraTipAmount - extraTipClawbackAmount).toFixed(2)
                  ),
            extraTipCreditedAt: dates[EXTRA_TIP_REFERENCE] || null,
            cashCollectedAmount,
            cashNet: parseFloat(
                Math.max(0, cashCollectedAmount - cashRefundedAmount).toFixed(2)
            ),
            cashRecordedAt: dates[CASH_COLLECTED_REFERENCE] || null,
            cashRefundedAmount,
            commissionClawbackAmount,
            extraTipClawbackAmount,
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

async function listRecentSettlementActivity(agentUserId, limit = 12) {
    const rows = await wallet.findAll({
        where: {
            userId: agentUserId,
            referenceType: {
                [Op.in]: [
                    CASH_COLLECTED_REFERENCE,
                    CASH_REMITTED_REFERENCE,
                    AGENT_PAYOUT_REFERENCE,
                    WITHDRAWAL_REFERENCE,
                    COMMISSION_CLAWBACK_REFERENCE,
                    CASH_REFUNDED_REFERENCE,
                    EXTRA_TIP_CLAWBACK_REFERENCE,
                    ADMIN_SETTLEMENT_REFERENCE,
                    EXTRA_TIP_REFERENCE,
                ],
            },
        },
        order: [
            ["createdAt", "DESC"],
            ["id", "DESC"],
        ],
        limit,
        include: [
            {
                model: booking,
                as: "booking",
                attributes: ["id", "orderTrackId"],
                required: false,
            },
        ],
    });

    return rows.map((row) => {
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
            stripeTransferId: plain.stripeTransferId || null,
            createdAt: plain.createdAt,
        };
    });
}

module.exports = {
    COMMISSION_REFERENCE,
    COMMISSION_CLAWBACK_REFERENCE,
    EXTRA_TIP_REFERENCE,
    EXTRA_TIP_CLAWBACK_REFERENCE,
    CASH_COLLECTED_REFERENCE,
    CASH_REFUNDED_REFERENCE,
    CASH_REMITTED_REFERENCE,
    ADMIN_SETTLEMENT_REFERENCE,
    PAYOUT_REFERENCE,
    AGENT_PAYOUT_REFERENCE,
    WITHDRAWAL_REFERENCE,
    CUSTOMER_REFUND_REFERENCE,
    classifyAgentEarningChannel,
    creditAgentForPaidBooking,
    creditExtraTipForBooking,
    backfillWalletsFromPaidBookings,
    backfillMissingCashLedger,
    hasSettlementActivity,
    getWalletSummary,
    getWalletTransactions,
    listAdminSettlementLedger,
    listAgentOrderBreakdown,
    listRecentSettlementActivity,
    hasCommissionCredit,
    getCommissionLedgerByBookingIds,
    getNetCommissionForBooking,
    getNetCashCollectedForBooking,
    getNetExtraTipForBooking,
    clawbackCommissionForRefund,
    reverseCashCollectedForRefund,
    clawbackExtraTipForRefund,
    resolveShopOwnerUserId,
};

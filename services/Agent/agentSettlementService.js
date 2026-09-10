const { wallet, addressDb, users, bussinessInformation } = require("../../models");
const { Op } = require("sequelize");
const {
    ValidationError,
    NotFoundError,
} = require("../../middlewares/universalErrorHandler");
const agentWalletService = require("./agentWalletService");

const {
    CASH_REMITTED_REFERENCE,
    ADMIN_SETTLEMENT_REFERENCE,
    AGENT_PAYOUT_REFERENCE,
} = agentWalletService;

const DEFAULT_CURRENCY = "GBP";
const SHOP_ADDRESS_TYPE = "LaundaryShopAddress";

function parsePositiveId(value, label) {
    const id = parseInt(value, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError(`${label} must be a positive integer`);
    }
    return id;
}

async function resolveAgentShop(agentUserId) {
    const shop = await addressDb.findOne({
        where: {
            userId: agentUserId,
            addressType: SHOP_ADDRESS_TYPE,
        },
        attributes: ["id", "userId", "streetAddress", "district"],
    });
    if (!shop) {
        throw new NotFoundError("Agent shop address not found");
    }
    return shop;
}

/** Public admin identity is the shop. Wallet still settles on the owner user. */
async function resolveShopForSettlement(shopId) {
    const id = parsePositiveId(shopId, "shopId");
    const shop = await addressDb.findOne({
        where: {
            id,
            addressType: SHOP_ADDRESS_TYPE,
        },
        attributes: ["id", "userId", "streetAddress", "district"],
    });
    if (!shop) {
        throw new NotFoundError("Shop not found");
    }
    if (!shop.userId) {
        throw new NotFoundError("Shop has no owner account");
    }
    return shop;
}

async function shopIdsByOwnerUserIds(userIds) {
    const ids = [...new Set((userIds || []).filter(Boolean).map((id) => Number(id)))];
    if (!ids.length) return new Map();
    const shops = await addressDb.findAll({
        where: {
            userId: { [Op.in]: ids },
            addressType: SHOP_ADDRESS_TYPE,
        },
        attributes: ["id", "userId"],
    });
    return new Map(shops.map((shop) => [Number(shop.userId), shop.id]));
}

/**
 * Agent reports cash handed to admin (pending until admin confirms).
 */
async function submitCashRemittance(agentUserId, { amount, note }) {
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new ValidationError("amount must be a positive number");
    }

    await resolveAgentShop(agentUserId);
    const summary = await agentWalletService.getWalletSummary(agentUserId);
    const availableToRemit = parseFloat(
        (summary.cashDueToPlatform - summary.pendingCashRemittance).toFixed(2)
    );

    if (availableToRemit <= 0) {
        throw new ValidationError("No cash balance is available to remit");
    }

    if (parsedAmount > availableToRemit + 0.02) {
        throw new ValidationError(
            `Remittance amount exceeds available cash due (${availableToRemit.toFixed(2)})`
        );
    }

    const entry = await wallet.create({
        userId: agentUserId,
        bookingId: null,
        referenceType: CASH_REMITTED_REFERENCE,
        amount: parseFloat(parsedAmount.toFixed(2)),
        currency: summary.currency || DEFAULT_CURRENCY,
        type: "credit",
        status: "pending",
        description: note
            ? `Cash remittance (pending): ${note}`
            : "Cash remittance submitted (pending admin confirmation)",
    });

    return {
        remittanceId: entry.id,
        amount: parseFloat(entry.amount),
        status: entry.status,
        currency: entry.currency,
        cashDueToPlatform: summary.cashDueToPlatform,
    };
}

async function listPendingRemittances(options = {}) {
    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const where = {
        referenceType: CASH_REMITTED_REFERENCE,
        type: "credit",
        status: "pending",
    };
    if (options.agentUserId) {
        where.userId = options.agentUserId;
    }

    const { count, rows } = await wallet.findAndCountAll({
        where,
        order: [["createdAt", "ASC"]],
        limit,
        offset,
        include: [
            {
                model: users,
                as: "user",
                attributes: ["id", "firstName", "lastName", "email"],
                required: false,
            },
        ],
    });

    const totalPages = count > 0 ? Math.ceil(count / limit) : 0;
    const shopByOwner = await shopIdsByOwnerUserIds(rows.map((row) => row.userId));

    return {
        remittances: rows.map((row) => {
            const plain = row.get({ plain: true });
            return {
                id: plain.id,
                shopId: shopByOwner.get(Number(plain.userId)) || null,
                agentUserId: plain.userId,
                agentName: plain.user
                    ? `${plain.user.firstName || ""} ${plain.user.lastName || ""}`.trim()
                    : null,
                agentEmail: plain.user ? plain.user.email : null,
                amount: parseFloat(plain.amount || 0),
                currency: plain.currency,
                description: plain.description,
                status: plain.status,
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

async function updateRemittanceStatus(remittanceId, status, adminNote) {
    const entry = await wallet.findOne({
        where: {
            id: remittanceId,
            referenceType: CASH_REMITTED_REFERENCE,
            type: "credit",
            status: "pending",
        },
    });

    if (!entry) {
        throw new NotFoundError("Pending remittance not found");
    }

    const description = adminNote
        ? `${entry.description} — ${status}: ${adminNote}`
        : `${entry.description} — ${status}`;

    await entry.update({
        status,
        description,
    });

    const summary = await agentWalletService.getWalletSummary(entry.userId);

    const shopByOwner = await shopIdsByOwnerUserIds([entry.userId]);
    return {
        remittanceId: entry.id,
        shopId: shopByOwner.get(Number(entry.userId)) || null,
        agentUserId: entry.userId,
        amount: parseFloat(entry.amount || 0),
        status: entry.status,
        settlement: summary,
    };
}

async function confirmCashRemittance(remittanceId, adminNote) {
    return updateRemittanceStatus(remittanceId, "completed", adminNote);
}

async function rejectCashRemittance(remittanceId, adminNote) {
    return updateRemittanceStatus(remittanceId, "failed", adminNote);
}

/**
 * Admin directly records cash received from agent (no pending step).
 */
async function adminRecordCashSettlement(agentUserId, { amount, note, adminUserId }) {
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new ValidationError("amount must be a positive number");
    }

    await resolveAgentShop(agentUserId);
    const summary = await agentWalletService.getWalletSummary(agentUserId);
    const availableToCollect = parseFloat(
        (summary.cashDueToPlatform - (summary.pendingCashRemittance || 0)).toFixed(2)
    );

    if (availableToCollect <= 0) {
        throw new ValidationError("No cash is currently due from this agent");
    }

    if (parsedAmount > availableToCollect + 0.02) {
        throw new ValidationError(
            `Amount exceeds cash still due (${availableToCollect.toFixed(2)})`
        );
    }

    const adminSuffix = adminUserId ? ` (admin #${adminUserId})` : "";
    const entry = await wallet.create({
        userId: agentUserId,
        bookingId: null,
        referenceType: CASH_REMITTED_REFERENCE,
        amount: parseFloat(parsedAmount.toFixed(2)),
        currency: summary.currency || DEFAULT_CURRENCY,
        type: "credit",
        status: "completed",
        description: note
            ? `Cash settlement recorded by admin${adminSuffix}: ${note}`
            : `Cash settlement recorded by admin${adminSuffix}`,
    });

    const updatedSummary = await agentWalletService.getWalletSummary(agentUserId);

    return {
        settlementId: entry.id,
        amount: parseFloat(entry.amount),
        settlement: updatedSummary,
    };
}

/**
 * Admin manual adjustment (e.g. correction, bonus, penalty).
 */
async function adminRecordAdjustment(agentUserId, { amount, direction, note }) {
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new ValidationError("amount must be a positive number");
    }

    const normalizedDirection = String(direction || "credit").toLowerCase();
    if (normalizedDirection !== "credit" && normalizedDirection !== "debit") {
        throw new ValidationError("direction must be 'credit' or 'debit'");
    }

    await resolveAgentShop(agentUserId);
    const summary = await agentWalletService.getWalletSummary(agentUserId);

    const entry = await wallet.create({
        userId: agentUserId,
        bookingId: null,
        referenceType: ADMIN_SETTLEMENT_REFERENCE,
        amount: parseFloat(parsedAmount.toFixed(2)),
        currency: summary.currency || DEFAULT_CURRENCY,
        type: normalizedDirection,
        status: "completed",
        description: note || "Admin settlement adjustment",
    });

    const updatedSummary = await agentWalletService.getWalletSummary(agentUserId);

    return {
        adjustmentId: entry.id,
        amount: parseFloat(entry.amount),
        type: entry.type,
        settlement: updatedSummary,
    };
}

/**
 * Admin releases (pays out) the agent's card earnings into the agent's
 * withdrawable wallet. This creates a CREDIT (money in) — it increases the
 * agent's wallet Credit / available balance. It does NOT create a debit.
 *
 * The payable amount is capped at the agent's card earnings not yet paid out,
 * so the same earnings can never be paid twice.
 */
async function recordAgentPayout(agentUserId, { amount, note, adminUserId }) {
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new ValidationError("amount must be a positive number");
    }

    await resolveAgentShop(agentUserId);
    const summary = await agentWalletService.getWalletSummary(agentUserId);

    if (summary.platformOwesAgent <= 0) {
        throw new ValidationError("No earnings available to pay out to this agent");
    }

    if (parsedAmount > summary.platformOwesAgent + 0.02) {
        throw new ValidationError(
            `Payout exceeds payable balance (${summary.platformOwesAgent.toFixed(2)})`
        );
    }

    const entry = await wallet.create({
        userId: agentUserId,
        bookingId: null,
        referenceType: AGENT_PAYOUT_REFERENCE,
        amount: parseFloat(parsedAmount.toFixed(2)),
        currency: summary.currency || DEFAULT_CURRENCY,
        type: "credit",
        status: "completed",
        description: note
            ? `${note}${adminUserId ? ` (admin #${adminUserId})` : ""}`
            : `Agent earnings payout${adminUserId ? ` (admin #${adminUserId})` : ""}`,
    });

    const updatedSummary = await agentWalletService.getWalletSummary(agentUserId);

    return {
        payoutId: entry.id,
        amount: parseFloat(entry.amount),
        settlement: updatedSummary,
    };
}

async function getAgentSettlementSummary(agentUserId) {
    await resolveAgentShop(agentUserId);
    return agentWalletService.getWalletSummary(agentUserId);
}

async function getShopSettlementSummary(shopId) {
    const shop = await resolveShopForSettlement(shopId);
    return getAgentSettlementSummary(shop.userId);
}

async function getShopSettlementDetail(shopId, options = {}) {
    const shop = await resolveShopForSettlement(shopId);
    return getAgentSettlementDetail(shop.userId, options);
}

async function adminRecordShopCashSettlement(shopId, payload) {
    const shop = await resolveShopForSettlement(shopId);
    return adminRecordCashSettlement(shop.userId, payload);
}

async function adminRecordShopAdjustment(shopId, payload) {
    const shop = await resolveShopForSettlement(shopId);
    return adminRecordAdjustment(shop.userId, payload);
}

async function recordShopPayout(shopId, payload) {
    const shop = await resolveShopForSettlement(shopId);
    return recordAgentPayout(shop.userId, payload);
}

/**
 * Full enterprise-grade settlement detail for one agent: identity, aggregate
 * summary, the complete wallet ledger (every credit/debit that fed the
 * summary numbers), and the per-order breakdown of what was collected/earned
 * on each completed order. Powers the admin "view" detail page so nothing is
 * hidden behind a single modal with just the totals.
 */
async function getAgentSettlementDetail(agentUserId, options = {}) {
    const shop = await resolveAgentShop(agentUserId);

    const emptyPage = { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false };

    const [agentUser, businessInfo, summary, ledger, orders, recentActivity] = await Promise.all([
        users.findByPk(agentUserId, {
            attributes: ["id", "firstName", "lastName", "email", "phoneNum", "status", "createdAt"],
        }),
        bussinessInformation.findOne({
            where: { shopAddressId: shop.id },
            attributes: ["shopName", "connectAccountId", "isConnectAccountConnected"],
        }),
        agentWalletService.getWalletSummary(agentUserId),
        agentWalletService.listAdminSettlementLedger(agentUserId, {
            page: options.ledgerPage,
            limit: options.ledgerLimit,
            rail: options.ledgerRail,
            referenceType: options.ledgerType,
        }).catch((err) => {
            console.warn(`[settlement-detail] ledger skipped for ${agentUserId}:`, err.message);
            return { transactions: [], pagination: emptyPage, statement: null };
        }),
        agentWalletService.listAgentOrderBreakdown(agentUserId, {
            page: options.ordersPage,
            limit: options.ordersLimit,
        }).catch((err) => {
            console.warn(`[settlement-detail] orders skipped for ${agentUserId}:`, err.message);
            return { orders: [], pagination: emptyPage };
        }),
        agentWalletService.listRecentSettlementActivity(agentUserId, 12).catch((err) => {
            console.warn(`[settlement-detail] activity skipped for ${agentUserId}:`, err.message);
            return [];
        }),
    ]);

    return {
        identity: {
            shopId: shop.id,
            ownerUserId: agentUser?.id || agentUserId,
        },
        agent: {
            id: agentUser?.id || agentUserId,
            name: agentUser
                ? `${agentUser.firstName || ""} ${agentUser.lastName || ""}`.trim()
                : null,
            email: agentUser?.email || null,
            phone: agentUser?.phoneNum || null,
            status: agentUser?.status,
            joinedAt: agentUser?.createdAt || null,
        },
        shop: {
            id: shop.id,
            name: businessInfo?.shopName || null,
            address: shop.streetAddress || null,
            district: shop.district || null,
            connectAccountConnected: Boolean(
                businessInfo?.connectAccountId && businessInfo?.isConnectAccountConnected
            ),
        },
        summary,
        ledger: ledger.transactions,
        ledgerPagination: ledger.pagination,
        statement: ledger.statement || null,
        orders: orders.orders,
        ordersPagination: orders.pagination,
        recentActivity,
        formulas: {
            cashDue:
                "Ledger cash due = cash collected − cash refunded − commission credited (cash + card, net of clawbacks) − cash remitted ± admin adjustments. Recording cash raises remitted and can make live due £0 — remitted history stays.",
            cashInTill:
                "Physical cash still with the agent before commission netting = collected − refunded − remitted.",
            payable:
                "Still payable = card commission + extra tips − extra-tip clawbacks − payouts already released to the agent wallet.",
            withdrawn:
                "Payouts released sit in the agent wallet until they withdraw to Stripe Connect. That is when money actually leaves the platform.",
            statement:
                "Bank-statement view: Money in / Money out per row, with settlement balance before & after. Negative settlement balance = cash due to platform. Wallet balance tracks payouts minus withdrawals.",
            cashPaymentFlow:
                "Cash COD: invoice → proceed unpaid → deliver → recordCashPayment → cash_collected + commission → agent remits / admin records cash received.",
        },
    };
}

async function listAgentsWithCashDue(options = {}) {
    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    try {
        await agentWalletService.backfillMissingCashLedger({ limit: 200 });
    } catch (err) {
        console.warn(
            "[cash-due] wallet self-heal failed:",
            err.message
        );
    }

    const shops = await addressDb.findAll({
        where: {
            addressType: "LaundaryShopAddress",
            userId: { [Op.ne]: null },
        },
        attributes: ["id", "userId", "streetAddress", "district"],
        include: [
            {
                model: users,
                attributes: ["id", "firstName", "lastName", "email"],
                required: false,
            },
            {
                model: bussinessInformation,
                attributes: ["shopName"],
                required: false,
            },
        ],
    });

    const summaries = [];
    for (const shop of shops) {
        if (!shop.userId) continue;
        try {
            const summary = await agentWalletService.getWalletSummary(shop.userId);
            if (agentWalletService.hasSettlementActivity(summary)) {
                const businessRows = shop.bussinessInformations || shop.bussinessInformation;
                const shopName = Array.isArray(businessRows)
                    ? businessRows[0]?.shopName
                    : businessRows?.shopName;
                summaries.push({
                    agentUserId: shop.userId,
                    shopId: shop.id,
                    shopName: shopName || null,
                    shopAddress: shop.streetAddress,
                    agentName: shop.user
                        ? `${shop.user.firstName || ""} ${shop.user.lastName || ""}`.trim()
                        : null,
                    agentEmail: shop.user?.email || null,
                    ...summary,
                });
            }
        } catch (err) {
            console.warn(
                `[cash-due] skipped shop ${shop.id} user ${shop.userId}:`,
                err.message
            );
        }
    }

    summaries.sort((a, b) => b.cashDueToPlatform - a.cashDueToPlatform);
    const total = summaries.length;
    const paged = summaries.slice(offset, offset + limit);
    const totalPages = total > 0 ? Math.ceil(total / limit) : 0;

    return {
        agents: paged,
        pagination: {
            page,
            limit,
            total,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
        },
    };
}

async function syncAgentWalletsFromBookings(options = {}) {
    return agentWalletService.backfillWalletsFromPaidBookings(options);
}

module.exports = {
    submitCashRemittance,
    listPendingRemittances,
    confirmCashRemittance,
    rejectCashRemittance,
    adminRecordCashSettlement,
    adminRecordAdjustment,
    recordAgentPayout,
    getAgentSettlementSummary,
    getAgentSettlementDetail,
    getShopSettlementSummary,
    getShopSettlementDetail,
    adminRecordShopCashSettlement,
    adminRecordShopAdjustment,
    recordShopPayout,
    listAgentsWithCashDue,
    syncAgentWalletsFromBookings,
    resolveShopForSettlement,
};

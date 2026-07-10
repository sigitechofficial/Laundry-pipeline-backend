const { wallet, addressDb, users } = require("../../models");
const { Op } = require("sequelize");
const {
    ValidationError,
    NotFoundError,
} = require("../../middlewares/universalErrorHandler");
const agentWalletService = require("./agentWalletService");

const {
    CASH_REMITTED_REFERENCE,
    ADMIN_SETTLEMENT_REFERENCE,
    PAYOUT_REFERENCE,
} = agentWalletService;

const DEFAULT_CURRENCY = "GBP";

async function resolveAgentShop(agentUserId) {
    const shop = await addressDb.findOne({
        where: {
            userId: agentUserId,
            addressType: "LaundaryShopAddress",
        },
        attributes: ["id", "userId", "streetAddress", "district"],
    });
    if (!shop) {
        throw new NotFoundError("Agent shop address not found");
    }
    return shop;
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
                attributes: ["id", "firstName", "lastName", "email"],
                required: false,
            },
        ],
    });

    const totalPages = count > 0 ? Math.ceil(count / limit) : 0;

    return {
        remittances: rows.map((row) => {
            const plain = row.get({ plain: true });
            return {
                id: plain.id,
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

    return {
        remittanceId: entry.id,
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
async function adminRecordCashSettlement(agentUserId, { amount, note }) {
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new ValidationError("amount must be a positive number");
    }

    await resolveAgentShop(agentUserId);
    const summary = await agentWalletService.getWalletSummary(agentUserId);

    const entry = await wallet.create({
        userId: agentUserId,
        bookingId: null,
        referenceType: CASH_REMITTED_REFERENCE,
        amount: parseFloat(parsedAmount.toFixed(2)),
        currency: summary.currency || DEFAULT_CURRENCY,
        type: "credit",
        status: "completed",
        description: note
            ? `Cash settlement recorded by admin: ${note}`
            : "Cash settlement recorded by admin",
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
 * Record platform payout to agent (card earnings disbursed).
 */
async function recordAgentPayout(agentUserId, { amount, note }) {
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new ValidationError("amount must be a positive number");
    }

    await resolveAgentShop(agentUserId);
    const summary = await agentWalletService.getWalletSummary(agentUserId);

    if (summary.platformOwesAgent <= 0) {
        throw new ValidationError("No positive balance payable to this agent");
    }

    if (parsedAmount > summary.platformOwesAgent + 0.02) {
        throw new ValidationError(
            `Payout exceeds payable balance (${summary.platformOwesAgent.toFixed(2)})`
        );
    }

    const entry = await wallet.create({
        userId: agentUserId,
        bookingId: null,
        referenceType: PAYOUT_REFERENCE,
        amount: parseFloat(parsedAmount.toFixed(2)),
        currency: summary.currency || DEFAULT_CURRENCY,
        type: "debit",
        status: "completed",
        description: note || "Agent earnings payout",
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

async function listAgentsWithCashDue(options = {}) {
    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

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
        ],
    });

    const summaries = [];
    for (const shop of shops) {
        if (!shop.userId) continue;
        try {
            const summary = await agentWalletService.getWalletSummary(shop.userId);
            if (summary.cashDueToPlatform > 0 || summary.pendingCashRemittance > 0) {
                summaries.push({
                    agentUserId: shop.userId,
                    shopId: shop.id,
                    shopAddress: shop.streetAddress,
                    agentName: shop.user
                        ? `${shop.user.firstName || ""} ${shop.user.lastName || ""}`.trim()
                        : null,
                    agentEmail: shop.user?.email || null,
                    ...summary,
                });
            }
        } catch (_) {
            /* skip shops without valid wallet */
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

module.exports = {
    submitCashRemittance,
    listPendingRemittances,
    confirmCashRemittance,
    rejectCashRemittance,
    adminRecordCashSettlement,
    adminRecordAdjustment,
    recordAgentPayout,
    getAgentSettlementSummary,
    listAgentsWithCashDue,
};

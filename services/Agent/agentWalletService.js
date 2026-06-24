const {
    booking,
    billingDetails,
    addressDb,
    wallet,
    units,
    zone,
} = require("../../models");
const { Op } = require("sequelize");
const { NotFoundError } = require("../../middlewares/universalErrorHandler");
const invoiceManagementService = require("./invoiceManagementService");

const COMMISSION_REFERENCE = "booking_commission";
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

async function hasCommissionCredit(bookingId) {
    const existing = await wallet.findOne({
        where: {
            bookingId,
            referenceType: COMMISSION_REFERENCE,
            type: "credit",
            status: "completed",
        },
        attributes: ["id"],
    });
    return Boolean(existing);
}

/**
 * Credit agent wallet when booking is fully paid. Idempotent per booking.
 * @returns {{ credited: boolean, amount?: number, walletId?: number, reason?: string }}
 */
async function creditAgentForPaidBooking(bookingId) {
    const bookingRow = await booking.findByPk(bookingId, {
        attributes: [
            "id",
            "orderTrackId",
            "laundryShopId",
            "zoneId",
            "paymentType",
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

    if (await hasCommissionCredit(bookingId)) {
        return { credited: false, reason: "already_credited" };
    }

    const currency = await resolveCurrencyForBooking(bookingRow);
    const orderLabel = bookingRow.orderTrackId || String(bookingId);

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
        amount: agentEarning,
        walletId: entry.id,
        agentUserId,
    };
}

async function sumWalletAmount(userId, type) {
    const rows = await wallet.findAll({
        where: {
            userId,
            type,
            status: "completed",
        },
        attributes: ["amount"],
        raw: true,
    });
    return rows.reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
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

    const totalCredited = await sumWalletAmount(agentUserId, "credit");
    const totalDebited = await sumWalletAmount(agentUserId, "debit");
    const balance = parseFloat((totalCredited - totalDebited).toFixed(2));

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

    return {
        balance,
        currency,
        totalCredited: parseFloat(totalCredited.toFixed(2)),
        totalDebited: parseFloat(totalDebited.toFixed(2)),
        commissionCreditCount: commissionCredits,
    };
}

async function getWalletTransactions(agentUserId, options = {}) {
    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const summary = await getWalletSummary(agentUserId);

    const { count, rows } = await wallet.findAndCountAll({
        where: { userId: agentUserId },
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
            "createdAt",
        ],
        include: [
            {
                model: booking,
                attributes: ["id", "orderTrackId"],
                required: false,
            },
        ],
    });

    const totalPages = count > 0 ? Math.ceil(count / limit) : 0;

    return {
        balance: summary.balance,
        currency: summary.currency,
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
    creditAgentForPaidBooking,
    getWalletSummary,
    getWalletTransactions,
    hasCommissionCredit,
};

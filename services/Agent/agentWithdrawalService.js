"use strict";

/**
 * Agent withdrawal requests + Stripe Connect payout account.
 *
 * Enterprise flow:
 * 1. Agent requests withdrawal (≤ available balance) → wallets row pending.
 * 2. Admin reviews, approves (Stripe Transfer) or rejects (balance un-reserves).
 * 3. Payout destination = Stripe Connect Express (created by default at signup).
 *    Bank details stay in Stripe; admin can ensure Connect + open onboarding link.
 *
 * Instant transfer (legacy) only when AGENT_WITHDRAW_INSTANT=1.
 */

const { Op } = require("sequelize");
const {
    addressDb,
    bussinessInformation,
    sequelize,
    wallet,
    users,
} = require("../../models");
const {
    NotFoundError,
    ValidationError,
} = require("../../middlewares/universalErrorHandler");
const stripeService = require("../../controllers/stripe");
const agentWalletService = require("./agentWalletService");
const { AGENT_WITHDRAWAL_REQUEST_PREFIX } = require("../../utils/adminPayoutLedger");

const {
    AGENT_PAYOUT_REFERENCE,
    WITHDRAWAL_REFERENCE,
} = agentWalletService;

const MIN_WITHDRAWAL_GBP = 1;
const SHOP_ADDRESS_TYPE = "LaundaryShopAddress";

function instantWithdrawEnabled() {
    return String(process.env.AGENT_WITHDRAW_INSTANT || "").trim() === "1";
}

function normalizeAmount(amount) {
    if (amount === null || amount === undefined || amount === "") {
        throw new ValidationError("amount is required");
    }

    const parsed = Number(amount);
    if (!Number.isFinite(parsed)) {
        throw new ValidationError("amount must be a valid number");
    }

    const amountInCents = Math.round(parsed * 100);
    if (Math.abs(parsed * 100 - amountInCents) > 0.000001) {
        throw new ValidationError("amount cannot have more than 2 decimal places");
    }
    if (amountInCents < MIN_WITHDRAWAL_GBP * 100) {
        throw new ValidationError(
            `Minimum withdrawal amount is £${MIN_WITHDRAWAL_GBP.toFixed(2)}`
        );
    }

    return amountInCents / 100;
}

async function resolveShopByUserId(agentUserId, transaction = null, lock = false) {
    const shop = await addressDb.findOne({
        where: {
            userId: agentUserId,
            addressType: SHOP_ADDRESS_TYPE,
        },
        attributes: ["id", "userId"],
        transaction,
        ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!shop) {
        throw new NotFoundError("Agent shop address not found");
    }
    return shop;
}

/**
 * Admin's public shop id is `bussinessInformation.id` (what Shop Management and
 * Cash Settlement link to). Resolve in the same order as
 * agentSettlementService.resolveShopForSettlement so every /shops/:shopId/*
 * endpoint accepts the same id: business id → owner user id → shop address id,
 * then the legacy raw address id.
 */
async function resolveShopByShopId(shopId) {
    const id = parseInt(shopId, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError("shopId must be a positive integer");
    }

    const bizAttrs = ["id", "agentId", "shopAddressId"];
    let biz = await bussinessInformation.findOne({ where: { id }, attributes: bizAttrs });
    if (!biz) biz = await bussinessInformation.findOne({ where: { agentId: id }, attributes: bizAttrs });
    if (!biz) biz = await bussinessInformation.findOne({ where: { shopAddressId: id }, attributes: bizAttrs });

    const shopAttrs = ["id", "userId"];
    let shop = null;
    if (biz?.shopAddressId) {
        shop = await addressDb.findOne({
            where: { id: biz.shopAddressId, addressType: SHOP_ADDRESS_TYPE },
            attributes: shopAttrs,
        });
    }
    if (!shop && biz?.agentId) {
        shop = await addressDb.findOne({
            where: { userId: biz.agentId, addressType: SHOP_ADDRESS_TYPE },
            attributes: shopAttrs,
        });
    }
    if (!shop) {
        shop = await addressDb.findOne({
            where: { id, addressType: SHOP_ADDRESS_TYPE },
            attributes: shopAttrs,
        });
    }
    if (!shop) {
        throw new NotFoundError("Shop not found");
    }
    const userId = shop.userId || biz?.agentId || null;
    if (!userId) {
        throw new NotFoundError("Shop has no owner account");
    }
    return { id: shop.id, userId };
}

const BUSINESS_INFO_ATTRS = [
    "id",
    "shopName",
    "agentId",
    "shopAddressId",
    "connectAccountId",
    "isConnectAccountConnected",
];

/**
 * Business profile for a shop address. Falls back to the owner's profile when
 * `shopAddressId` was never backfilled on the business row.
 */
async function loadBusinessInfo(shopAddressId, transaction = null) {
    const byAddress = await bussinessInformation.findOne({
        where: { shopAddressId },
        attributes: BUSINESS_INFO_ATTRS,
        transaction,
    });
    if (byAddress) return byAddress;

    const shop = await addressDb.findOne({
        where: { id: shopAddressId, addressType: SHOP_ADDRESS_TYPE },
        attributes: ["id", "userId"],
        transaction,
    });
    if (!shop?.userId) return null;
    return bussinessInformation.findOne({
        where: { agentId: shop.userId },
        attributes: BUSINESS_INFO_ATTRS,
        transaction,
    });
}

async function sumLedgerAmount(where, transaction) {
    const value = await wallet.sum("amount", {
        where,
        transaction,
    });
    return Number(value || 0);
}

async function computeAvailableBalance(agentUserId, transaction) {
    const payoutCredits = await sumLedgerAmount(
        {
            userId: agentUserId,
            referenceType: AGENT_PAYOUT_REFERENCE,
            type: "credit",
            status: "completed",
        },
        transaction
    );
    const completedWithdrawals = await sumLedgerAmount(
        {
            userId: agentUserId,
            referenceType: WITHDRAWAL_REFERENCE,
            type: "debit",
            status: "completed",
        },
        transaction
    );
    const pendingWithdrawals = await sumLedgerAmount(
        {
            userId: agentUserId,
            referenceType: WITHDRAWAL_REFERENCE,
            type: "debit",
            status: "pending",
        },
        transaction
    );
    return Math.max(payoutCredits - completedWithdrawals - pendingWithdrawals, 0);
}

async function assertConnectReadyForTransfer(connectAccountId) {
    if (!connectAccountId) {
        throw new ValidationError(
            "Shop has no Stripe Connect payout account. Create or open onboarding first."
        );
    }
    const accountStatus = await stripeService.checkConnectAccountStatus(connectAccountId);
    if (
        !accountStatus.detailsSubmitted ||
        !accountStatus.payoutsEnabled ||
        !accountStatus.transfersEnabled
    ) {
        throw new ValidationError(
            "Stripe Connect onboarding is incomplete or transfers are not enabled. Open the payout onboarding link."
        );
    }
    return accountStatus;
}

/**
 * Transfer platform funds to the shop owner's Stripe Connect account.
 * Used by admin payout (pay now) and by approve-withdrawal.
 */
async function transferToAgentConnectAccount(agentUserId, amount, idempotencyKey, metadata = {}) {
    const shop = await resolveShopByUserId(agentUserId);
    let businessInfo = await loadBusinessInfo(shop.id);
    if (!businessInfo?.connectAccountId) {
        await ensureShopConnectAccount(shop.id);
        businessInfo = await loadBusinessInfo(shop.id);
    }
    await assertConnectReadyForTransfer(businessInfo?.connectAccountId);
    const transfer = await stripeService.transferToConnectAccount(
        amount,
        businessInfo.connectAccountId,
        idempotencyKey,
        {
            agentUserId,
            shopId: shop.id,
            ...metadata,
        }
    );
    return { transfer, shop, businessInfo };
}

/**
 * Ensure Express Connect account exists for the shop (created by default at signup;
 * heals missing accounts). Bank details remain in Stripe — add via onboarding link.
 */
async function ensureShopConnectAccount(shopId) {
    const shop = await resolveShopByShopId(shopId);
    let businessInfo = await loadBusinessInfo(shop.id);
    if (!businessInfo) {
        throw new NotFoundError("Shop business profile not found");
    }

    if (businessInfo.connectAccountId) {
        const status = await stripeService.checkConnectAccountStatus(
            businessInfo.connectAccountId
        );
        const connected = Boolean(
            status.detailsSubmitted && status.payoutsEnabled && status.transfersEnabled
        );
        if (connected !== Boolean(businessInfo.isConnectAccountConnected)) {
            await businessInfo.update({ isConnectAccountConnected: connected });
            businessInfo.isConnectAccountConnected = connected;
        }
        return {
            shopId: shop.id,
            agentUserId: shop.userId,
            shopName: businessInfo.shopName || null,
            connectAccountId: businessInfo.connectAccountId,
            isConnectAccountConnected: Boolean(businessInfo.isConnectAccountConnected),
            payoutsEnabled: Boolean(status.payoutsEnabled),
            transfersEnabled: Boolean(status.transfersEnabled),
            detailsSubmitted: Boolean(status.detailsSubmitted),
            created: false,
            bankAccountNote:
                "Bank details are managed in Stripe Connect. Use the onboarding link to add or update a bank account.",
        };
    }

    const owner = await users.findByPk(shop.userId, {
        attributes: ["id", "email"],
    });
    if (!owner?.email) {
        throw new ValidationError("Shop owner email is required to create a Stripe Connect account");
    }

    const created = await stripeService.createConnectAccount(owner.email, "GB");
    await businessInfo.update({
        connectAccountId: created.accountId,
        isConnectAccountConnected: false,
    });

    return {
        shopId: shop.id,
        agentUserId: shop.userId,
        shopName: businessInfo.shopName || null,
        connectAccountId: created.accountId,
        isConnectAccountConnected: false,
        payoutsEnabled: false,
        transfersEnabled: false,
        detailsSubmitted: false,
        created: true,
        onboardingUrl: created.accountLink || null,
        bankAccountNote:
            "Stripe Connect account created. Complete onboarding to add bank details for withdrawals.",
    };
}

async function getShopPayoutAccount(shopId) {
    const shop = await resolveShopByShopId(shopId);
    const businessInfo = await loadBusinessInfo(shop.id);
    if (!businessInfo) {
        throw new NotFoundError("Shop business profile not found");
    }

    let status = null;
    if (businessInfo.connectAccountId) {
        try {
            status = await stripeService.checkConnectAccountStatus(
                businessInfo.connectAccountId
            );
            const connected = Boolean(
                status.detailsSubmitted && status.payoutsEnabled && status.transfersEnabled
            );
            if (connected !== Boolean(businessInfo.isConnectAccountConnected)) {
                await businessInfo.update({ isConnectAccountConnected: connected });
                businessInfo.isConnectAccountConnected = connected;
            }
        } catch (err) {
            console.warn(
                `[payout-account] Stripe status failed for shop ${shop.id}:`,
                err.message
            );
        }
    }

    return {
        shopId: shop.id,
        agentUserId: shop.userId,
        shopName: businessInfo.shopName || null,
        connectAccountId: businessInfo.connectAccountId || null,
        isConnectAccountConnected: Boolean(businessInfo.isConnectAccountConnected),
        payoutsEnabled: Boolean(status?.payoutsEnabled),
        transfersEnabled: Boolean(status?.transfersEnabled),
        detailsSubmitted: Boolean(status?.detailsSubmitted),
        canReceiveTransfers: Boolean(
            businessInfo.connectAccountId &&
                status?.detailsSubmitted &&
                status?.payoutsEnabled &&
                status?.transfersEnabled
        ),
        bankAccountSupported: true,
        bankAccountManagedBy: "stripe_connect",
        bankAccountNote:
            "Primary payout method is Stripe Connect (created by default). Bank account is added in Stripe onboarding — not stored in Laundry admin.",
    };
}

async function createShopPayoutOnboardingLink(shopId) {
    const ensured = await ensureShopConnectAccount(shopId);
    if (!ensured.connectAccountId) {
        throw new ValidationError("Could not resolve Stripe Connect account");
    }
    if (ensured.onboardingUrl) {
        return {
            ...ensured,
            onboardingUrl: ensured.onboardingUrl,
        };
    }
    const url = await stripeService.createStripeAccountLink(ensured.connectAccountId);
    return {
        ...ensured,
        onboardingUrl: url,
    };
}

/**
 * Agent requests a withdrawal. Amount is reserved as a pending debit.
 * Does not call Stripe — admin approve executes the transfer.
 */
async function requestWithdrawal(agentUserId, rawAmount, options = {}) {
    const amount = normalizeAmount(rawAmount);
    const note = options.note ? String(options.note).trim().slice(0, 400) : "";

    // Heal missing Connect account so payout destination exists by default.
    const shop = await resolveShopByUserId(agentUserId);
    const businessInfo = await loadBusinessInfo(shop.id);
    if (!businessInfo?.connectAccountId) {
        await ensureShopConnectAccount(shop.id);
    }

    let withdrawalEntry;
    await sequelize.transaction(async (transaction) => {
        await resolveShopByUserId(agentUserId, transaction, true);

        const available = await computeAvailableBalance(agentUserId, transaction);
        if (amount > available + 0.001) {
            throw new ValidationError(
                `Withdrawal exceeds available balance (£${available.toFixed(2)})`
            );
        }

        withdrawalEntry = await wallet.create(
            {
                userId: agentUserId,
                bookingId: null,
                referenceType: WITHDRAWAL_REFERENCE,
                amount,
                currency: "GBP",
                type: "debit",
                status: "pending",
                description: note
                    ? `Withdrawal request (pending admin approval): ${note}`
                    : "Withdrawal request (pending admin approval)",
            },
            { transaction }
        );
    });

    if (instantWithdrawEnabled()) {
        return approveWithdrawal(withdrawalEntry.id, {
            adminUserId: null,
            note: "Auto-approved (AGENT_WITHDRAW_INSTANT=1)",
        });
    }

    const summary = await agentWalletService.getWalletSummary(agentUserId);
    return {
        withdrawalId: withdrawalEntry.id,
        amount,
        currency: "GBP",
        status: "pending",
        message: "Withdrawal requested. Waiting for admin approval.",
        wallet: summary,
    };
}

/** @deprecated Prefer requestWithdrawal — kept for callers during rollout. */
async function withdrawAgentEarnings(agentUserId, rawAmount) {
    return requestWithdrawal(agentUserId, rawAmount);
}

async function listPendingWithdrawals(options = {}) {
    const page = Math.max(parseInt(options.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const where = {
        referenceType: WITHDRAWAL_REFERENCE,
        type: "debit",
        status: "pending",
        description: { [Op.like]: `${AGENT_WITHDRAWAL_REQUEST_PREFIX}%` },
    };
    if (options.agentUserId) {
        where.userId = parseInt(options.agentUserId, 10);
    }
    if (options.shopId) {
        const shop = await resolveShopByShopId(options.shopId);
        where.userId = shop.userId;
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
                attributes: ["id", "firstName", "lastName", "email", "phoneNum"],
                required: false,
            },
        ],
    });

    const ownerIds = [...new Set(rows.map((r) => r.userId).filter(Boolean))];
    const shops = ownerIds.length
        ? await addressDb.findAll({
              where: {
                  userId: { [Op.in]: ownerIds },
                  addressType: SHOP_ADDRESS_TYPE,
              },
              attributes: ["id", "userId"],
              include: [
                  {
                      model: bussinessInformation,
                      attributes: [
                          "shopName",
                          "connectAccountId",
                          "isConnectAccountConnected",
                      ],
                      required: false,
                  },
              ],
          })
        : [];
    const shopByOwner = new Map();
    for (const shop of shops) {
        const businessRows = shop.bussinessInformations || shop.bussinessInformation;
        const biz = Array.isArray(businessRows) ? businessRows[0] : businessRows;
        shopByOwner.set(Number(shop.userId), {
            shopId: shop.id,
            shopName: biz?.shopName || null,
            connectAccountId: biz?.connectAccountId || null,
            isConnectAccountConnected: Boolean(biz?.isConnectAccountConnected),
        });
    }

    const totalPages = count > 0 ? Math.ceil(count / limit) : 0;
    return {
        withdrawals: rows.map((row) => {
            const plain = row.get({ plain: true });
            const shopMeta = shopByOwner.get(Number(plain.userId)) || {};
            return {
                id: plain.id,
                shopId: shopMeta.shopId || null,
                shopName: shopMeta.shopName || null,
                agentUserId: plain.userId,
                agentName: plain.user
                    ? `${plain.user.firstName || ""} ${plain.user.lastName || ""}`.trim()
                    : null,
                agentEmail: plain.user?.email || null,
                agentPhone: plain.user?.phoneNum || null,
                amount: parseFloat(plain.amount || 0),
                currency: plain.currency || "GBP",
                description: plain.description || "",
                status: plain.status,
                createdAt: plain.createdAt,
                connectAccountId: shopMeta.connectAccountId || null,
                isConnectAccountConnected: Boolean(shopMeta.isConnectAccountConnected),
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

async function approveWithdrawal(withdrawalId, options = {}) {
    const id = parseInt(withdrawalId, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError("withdrawalId is required");
    }

    const entry = await wallet.findOne({
        where: {
            id,
            referenceType: WITHDRAWAL_REFERENCE,
            type: "debit",
            status: "pending",
        },
    });
    if (!entry) {
        throw new NotFoundError("Pending withdrawal request not found");
    }

    const shop = await resolveShopByUserId(entry.userId);
    let businessInfo = await loadBusinessInfo(shop.id);
    if (!businessInfo?.connectAccountId) {
        await ensureShopConnectAccount(shop.id);
        businessInfo = await loadBusinessInfo(shop.id);
    }

    await assertConnectReadyForTransfer(businessInfo.connectAccountId);

    const amount = parseFloat(entry.amount || 0);
    let transfer = null;
    try {
        transfer = await stripeService.transferToConnectAccount(
            amount,
            businessInfo.connectAccountId,
            `agent-withdrawal-wallet-${entry.id}`,
            {
                agentUserId: entry.userId,
                walletId: entry.id,
                withdrawalType: "agent_wallet",
                transferKind: "agent_withdrawal",
                approvedByAdminId: options.adminUserId || null,
            }
        );

        const adminNote = options.note ? String(options.note).trim().slice(0, 500) : null;
        await entry.update({
            status: "completed",
            stripeTransferId: transfer.id,
            failureReason: null,
            reviewedByAdminId: options.adminUserId || null,
            reviewedAt: new Date(),
            adminNote,
            description: adminNote
                ? `${entry.description} — approved: ${adminNote}`
                : `${entry.description} — approved`,
        });
    } catch (error) {
        if (!transfer) {
            // Leave as pending so admin can retry after fixing Connect / Stripe.
            // Do not mark failed unless reject — keeps balance reserved intentionally.
            throw error;
        }
        console.error(
            `[withdrawal approve] Stripe transfer ${transfer.id} succeeded but wallet ${entry.id} could not be completed:`,
            error
        );
        throw error;
    }

    const summary = await agentWalletService.getWalletSummary(entry.userId);
    return {
        withdrawalId: entry.id,
        stripeTransferId: transfer.id,
        amount,
        currency: entry.currency || "GBP",
        status: "completed",
        shopId: shop.id,
        agentUserId: entry.userId,
        wallet: summary,
    };
}

async function rejectWithdrawal(withdrawalId, options = {}) {
    const id = parseInt(withdrawalId, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError("withdrawalId is required");
    }
    const note = options.note ? String(options.note).trim().slice(0, 500) : "";
    if (!note) {
        throw new ValidationError("Rejection note is required");
    }

    const entry = await wallet.findOne({
        where: {
            id,
            referenceType: WITHDRAWAL_REFERENCE,
            type: "debit",
            status: "pending",
        },
    });
    if (!entry) {
        throw new NotFoundError("Pending withdrawal request not found");
    }

    await entry.update({
        status: "failed",
        failureReason: note,
        reviewedByAdminId: options.adminUserId || null,
        reviewedAt: new Date(),
        adminNote: note,
        description: `${entry.description} — rejected: ${note}`,
    });

    const summary = await agentWalletService.getWalletSummary(entry.userId);
    const shop = await resolveShopByUserId(entry.userId);
    return {
        withdrawalId: entry.id,
        amount: parseFloat(entry.amount || 0),
        currency: entry.currency || "GBP",
        status: "failed",
        shopId: shop.id,
        agentUserId: entry.userId,
        wallet: summary,
    };
}

module.exports = {
    MIN_WITHDRAWAL_GBP,
    requestWithdrawal,
    withdrawAgentEarnings,
    listPendingWithdrawals,
    approveWithdrawal,
    rejectWithdrawal,
    getShopPayoutAccount,
    ensureShopConnectAccount,
    createShopPayoutOnboardingLink,
    transferToAgentConnectAccount,
    assertConnectReadyForTransfer,
};

const {
    addressDb,
    bussinessInformation,
    sequelize,
    wallet,
} = require("../../models");
const {
    ConflictError,
    NotFoundError,
    ValidationError,
} = require("../../middlewares/universalErrorHandler");
const stripeService = require("../../controllers/stripe");
const agentWalletService = require("./agentWalletService");

const {
    AGENT_PAYOUT_REFERENCE,
    WITHDRAWAL_REFERENCE,
} = agentWalletService;

const MIN_WITHDRAWAL_GBP = 1;

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

async function resolveConnectAccount(agentUserId, transaction = null, lock = false) {
    const shop = await addressDb.findOne({
        where: {
            userId: agentUserId,
            addressType: "LaundaryShopAddress",
        },
        attributes: ["id", "userId"],
        transaction,
        ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });

    if (!shop) {
        throw new NotFoundError("Agent shop address not found");
    }

    const businessInfo = await bussinessInformation.findOne({
        where: { shopAddressId: shop.id },
        attributes: [
            "id",
            "connectAccountId",
            "isConnectAccountConnected",
        ],
        transaction,
    });

    if (!businessInfo?.connectAccountId) {
        throw new ValidationError(
            "Connect your Stripe account before withdrawing earnings"
        );
    }

    return { shop, businessInfo };
}

async function sumLedgerAmount(where, transaction) {
    const value = await wallet.sum("amount", {
        where,
        transaction,
    });
    return Number(value || 0);
}

/**
 * Withdraw an agent's available wallet credit to their Stripe Connect account.
 *
 * A pending row reserves the amount before Stripe is called. The shop row is
 * locked while reserving so simultaneous requests cannot overspend the wallet.
 */
async function withdrawAgentEarnings(agentUserId, rawAmount) {
    const amount = normalizeAmount(rawAmount);

    const { businessInfo } = await resolveConnectAccount(agentUserId);
    const accountStatus = await stripeService.checkConnectAccountStatus(
        businessInfo.connectAccountId
    );

    if (
        !accountStatus.detailsSubmitted ||
        !accountStatus.payoutsEnabled ||
        !accountStatus.transfersEnabled
    ) {
        throw new ValidationError(
            "Stripe Connect onboarding is incomplete or transfers are not enabled"
        );
    }

    let withdrawalEntry;
    await sequelize.transaction(async (transaction) => {
        const locked = await resolveConnectAccount(
            agentUserId,
            transaction,
            true
        );

        if (locked.businessInfo.connectAccountId !== businessInfo.connectAccountId) {
            throw new ConflictError(
                "Stripe Connect account changed. Please try again."
            );
        }

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

        const available = Math.max(
            payoutCredits - completedWithdrawals - pendingWithdrawals,
            0
        );
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
                description: "Withdrawal to Stripe Connect",
            },
            { transaction }
        );
    });

    let transfer = null;
    try {
        transfer = await stripeService.transferToConnectAccount(
            amount,
            businessInfo.connectAccountId,
            `agent-withdrawal-wallet-${withdrawalEntry.id}`,
            {
                agentUserId,
                walletId: withdrawalEntry.id,
                withdrawalType: "agent_wallet",
            }
        );

        await withdrawalEntry.update({
            status: "completed",
            stripeTransferId: transfer.id,
            failureReason: null,
        });
    } catch (error) {
        if (!transfer) {
            await withdrawalEntry.update({
                status: "failed",
                failureReason: String(error.message || "Stripe transfer failed").slice(
                    0,
                    500
                ),
            });
        } else {
            console.error(
                `[agent withdrawal] Stripe transfer ${transfer.id} succeeded but wallet ${withdrawalEntry.id} could not be completed:`,
                error
            );
        }
        throw error;
    }

    const summary = await agentWalletService.getWalletSummary(agentUserId);
    return {
        withdrawalId: withdrawalEntry.id,
        stripeTransferId: transfer.id,
        amount,
        currency: "GBP",
        status: "completed",
        wallet: summary,
    };
}

module.exports = {
    MIN_WITHDRAWAL_GBP,
    withdrawAgentEarnings,
};

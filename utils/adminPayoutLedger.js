'use strict';

const AGENT_PAYOUT_REFERENCE = 'agent_payout';
const WITHDRAWAL_REFERENCE = 'agent_withdrawal';
const ADMIN_PAYOUT_PROCESSING_PREFIX = 'Admin payout to Stripe Connect';
const AGENT_WITHDRAWAL_REQUEST_PREFIX = 'Withdrawal request';

function roundMoney(amount) {
    return parseFloat(Number(amount).toFixed(2));
}

function adminPayoutDescriptions(note, adminUserId) {
    const adminSuffix = adminUserId ? ` (admin #${adminUserId})` : '';
    const notePart = note ? `: ${String(note).trim().slice(0, 400)}` : '';
    return {
        credit: `Agent earnings payout to Stripe Connect${adminSuffix}${notePart}`,
        debit: `${ADMIN_PAYOUT_PROCESSING_PREFIX}${adminSuffix}${notePart}`,
    };
}

/**
 * Pair a completed payout credit with a completed Connect debit so the same
 * earnings cannot be withdrawn again after admin already sent them to Stripe.
 *
 * Only the CREDIT row carries stripeTransferId. wallets.stripeTransferId has a
 * UNIQUE index (wallets_stripe_transfer_id_unique), so writing the same
 * transfer id on both rows of the pair violates it — the completion
 * transaction in recordAgentPayout then rolls back AFTER the Stripe transfer
 * already succeeded, leaving the credit stuck "pending" with real money sent
 * and no ledger record of it. The credit is the canonical transfer record; the
 * debit is the paired internal "sent out" entry.
 */
function buildAdminConnectPayoutLedger({
    userId,
    amount,
    currency = 'GBP',
    note,
    adminUserId,
    stripeTransferId,
}) {
    const parsed = roundMoney(amount);
    const descriptions = adminPayoutDescriptions(note, adminUserId);
    return {
        credit: {
            userId,
            bookingId: null,
            referenceType: AGENT_PAYOUT_REFERENCE,
            amount: parsed,
            currency,
            type: 'credit',
            status: 'completed',
            stripeTransferId: stripeTransferId || null,
            description: descriptions.credit,
        },
        debit: {
            userId,
            bookingId: null,
            referenceType: WITHDRAWAL_REFERENCE,
            amount: parsed,
            currency,
            type: 'debit',
            status: 'completed',
            // Never the transfer id — see the unique-index note above.
            stripeTransferId: null,
            description: descriptions.debit,
        },
    };
}

function isAgentWithdrawalRequestDescription(description) {
    return String(description || '').startsWith(AGENT_WITHDRAWAL_REQUEST_PREFIX);
}

module.exports = {
    AGENT_PAYOUT_REFERENCE,
    WITHDRAWAL_REFERENCE,
    ADMIN_PAYOUT_PROCESSING_PREFIX,
    AGENT_WITHDRAWAL_REQUEST_PREFIX,
    roundMoney,
    adminPayoutDescriptions,
    buildAdminConnectPayoutLedger,
    isAgentWithdrawalRequestDescription,
};

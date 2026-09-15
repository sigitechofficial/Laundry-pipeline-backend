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
            stripeTransferId: stripeTransferId || null,
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

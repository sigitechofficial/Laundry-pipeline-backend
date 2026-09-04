'use strict';

const TIP_SOURCE = Object.freeze({
    BOOKING: 'booking',
    POST_COMPLETE: 'post_complete',
});

function isPostCompleteTip(row) {
    return String(row?.source || '').toLowerCase() === TIP_SOURCE.POST_COMPLETE;
}

function splitTips(tips = []) {
    const list = Array.isArray(tips) ? tips : [];
    const bookingTips = [];
    const extraTips = [];
    for (const row of list) {
        if (isPostCompleteTip(row)) extraTips.push(row);
        else bookingTips.push(row);
    }
    return { bookingTips, extraTips };
}

function sumTipAmounts(tips = []) {
    return (Array.isArray(tips) ? tips : []).reduce((sum, row) => {
        const n = parseFloat(row?.amount || 0);
        return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
}

function roundMoney(value) {
    const n = parseFloat(value || 0);
    return parseFloat((Number.isFinite(n) ? n : 0).toFixed(2));
}

/**
 * Split booking-time tip vs post-complete extra tip for admin/agent/customer UIs.
 * Invoice / payment-summary math should use bookingTipAmount only.
 */
function bookingTipAmountFromTips(tips = []) {
    return summarizeTips(tips).bookingTipAmount;
}

function extraTipAmountFromTips(tips = []) {
    return summarizeTips(tips).extraTipAmount;
}

function summarizeTips(tips = [], { canAdd = false } = {}) {
    const { bookingTips, extraTips } = splitTips(tips);
    const bookingTipAmount = roundMoney(sumTipAmounts(bookingTips));
    const extraTipAmount = roundMoney(sumTipAmounts(extraTips));
    return {
        bookingTipAmount,
        extraTipAmount,
        extraTips: extraTips.map((row) => ({
            id: row.id,
            amount: roundMoney(row.amount),
            source: row.source || TIP_SOURCE.POST_COMPLETE,
            paymentType: row.paymentType || null,
            stripePaymentIntentId: row.stripePaymentIntentId || null,
            paidAt: row.paidAt || row.createdAt || null,
            createdAt: row.createdAt || null,
        })),
        canAdd: Boolean(canAdd) && extraTipAmount <= 0,
        alreadyAdded: extraTipAmount > 0,
    };
}

module.exports = {
    TIP_SOURCE,
    isPostCompleteTip,
    splitTips,
    sumTipAmounts,
    bookingTipAmountFromTips,
    extraTipAmountFromTips,
    summarizeTips,
    roundMoney,
};

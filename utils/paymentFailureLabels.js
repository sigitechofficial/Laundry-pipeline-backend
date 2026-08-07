"use strict";

/** Human-readable labels for Stripe decline / error codes (admin + agent + push). */
const PAYMENT_FAILURE_LABELS = {
    generic_decline: "Card was declined by the bank",
    insufficient_funds: "Insufficient funds on the card",
    lost_card: "Card reported as lost",
    stolen_card: "Card reported as stolen",
    expired_card: "Card has expired",
    incorrect_cvc: "Incorrect card security code (CVC)",
    processing_error: "Bank processing error — try again later",
    card_not_supported: "Card type is not supported",
    currency_not_supported: "Currency not supported for this card",
    do_not_honor: "Bank declined the payment (do not honor)",
    card_velocity_exceeded: "Card spending limit reached",
    withdrawal_count_limit_exceeded: "Card transaction limit reached",
    try_again_later: "Temporary bank issue — try again later",
    authentication_required: "Card requires customer authentication",
    missing_payment_method: "No saved payment method on file",
    card_declined: "Card was declined",
};

/**
 * @param {string|null} code - stripe decline_code or code
 * @param {string|null} message - raw Stripe message
 * @returns {string}
 */
function formatPaymentFailureReason(code, message) {
    const key = String(code || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_");
    if (key && PAYMENT_FAILURE_LABELS[key]) {
        return PAYMENT_FAILURE_LABELS[key];
    }

    let msg = String(message || "").trim();
    if (msg.startsWith("Stripe Error: ")) {
        msg = msg.slice("Stripe Error: ".length).trim();
    }
    if (msg) return msg;
    return "Card payment failed";
}

module.exports = {
    PAYMENT_FAILURE_LABELS,
    formatPaymentFailureReason,
};

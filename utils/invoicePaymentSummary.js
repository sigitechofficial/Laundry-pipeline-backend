/**
 * Customer/agent-facing payment breakdown for laundry orders.
 *
 * Card: minimum + service fee + tip collected at pickup; credited on final invoice.
 * Cash: nothing at pickup; minimum (as laundry floor), service fee, and tip due at delivery.
 */

function roundMoney(value) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return 0;
    return parseFloat(n.toFixed(2));
}

function normalizePaymentType(value) {
    const normalized = String(value || "card").toLowerCase().trim();
    return normalized === "cash" ? "cash" : "card";
}

/**
 * Card bookings — minimum credited toward laundry on final invoice.
 */
function buildPaymentSummary({
    laundrySubtotal,
    serviceFee,
    minimumOrderPayment,
    driverTip,
    discount = 0,
    currency = "GBP",
    currencySymbol = "£",
}) {
    const laundry = roundMoney(laundrySubtotal);
    const service = roundMoney(serviceFee);
    const minimum = roundMoney(minimumOrderPayment);
    const tip = roundMoney(driverTip);
    const disc = roundMoney(discount);

    const totalOrderAmount = roundMoney(laundry + service + tip);
    const totalPaid = roundMoney(minimum + service + tip);
    const amountDueNow = roundMoney(Math.max(0, totalOrderAmount - totalPaid - disc));

    return {
        paymentType: "card",
        laundrySubtotal: laundry,
        minimumAdjustment: 0,
        effectiveLaundry: laundry,
        orderSummary: {
            laundrySubtotal: laundry,
            minimumAdjustment: 0,
            effectiveLaundry: laundry,
            serviceFee: service,
            driverTip: tip,
            discount: disc,
            totalOrderAmount,
        },
        paidAtBooking: {
            minimumOrderPayment: minimum,
            serviceFee: service,
            driverTip: tip,
            totalPaid,
        },
        amountDueNow,
        currency,
        currencySymbol,
    };
}

/**
 * Cash bookings — full bill (with minimum floor on laundry) due at delivery.
 */
function buildCashPaymentSummary({
    laundrySubtotal,
    serviceFee,
    minimumOrderPayment,
    driverTip,
    discount = 0,
    currency = "GBP",
    currencySymbol = "£",
}) {
    const laundry = roundMoney(laundrySubtotal);
    const service = roundMoney(serviceFee);
    const minimum = roundMoney(minimumOrderPayment);
    const tip = roundMoney(driverTip);
    const disc = roundMoney(discount);

    const effectiveLaundry = roundMoney(Math.max(laundry, minimum));
    const minimumAdjustment = roundMoney(Math.max(0, minimum - laundry));
    const totalOrderAmount = roundMoney(effectiveLaundry + service + tip);
    const amountDueNow = roundMoney(Math.max(0, totalOrderAmount - disc));

    return {
        paymentType: "cash",
        laundrySubtotal: laundry,
        minimumAdjustment,
        effectiveLaundry,
        orderSummary: {
            laundrySubtotal: laundry,
            minimumAdjustment,
            effectiveLaundry,
            serviceFee: service,
            driverTip: tip,
            discount: disc,
            totalOrderAmount,
        },
        paidAtBooking: {
            minimumOrderPayment: 0,
            serviceFee: 0,
            driverTip: 0,
            totalPaid: 0,
        },
        amountDueNow,
        currency,
        currencySymbol,
    };
}

function buildPaymentSummaryForBooking(paymentType, params) {
    if (normalizePaymentType(paymentType) === "cash") {
        return buildCashPaymentSummary(params);
    }
    return buildPaymentSummary(params);
}

module.exports = {
    buildPaymentSummary,
    buildCashPaymentSummary,
    buildPaymentSummaryForBooking,
    normalizePaymentType,
    roundMoney,
};

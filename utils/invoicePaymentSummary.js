/**
 * Customer/agent-facing payment breakdown for laundry orders.
 *
 * Minimum order payment is credited toward the order (not charged again on the invoice).
 * totalOrderAmount = laundry + service fee + tip (minimum is not a separate line here).
 * amountDueNow = totalOrderAmount - paidAtBooking.totalPaid - discount
 */

function roundMoney(value) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return 0;
    return parseFloat(n.toFixed(2));
}

/**
 * @param {Object} params
 * @param {number} params.laundrySubtotal - Itemised laundry + add-ons total
 * @param {number} params.serviceFee
 * @param {number} params.minimumOrderPayment - Zone minimum / upfront amount paid at booking
 * @param {number} params.driverTip
 * @param {number} [params.discount=0]
 * @param {string} [params.currency='GBP']
 * @param {string} [params.currencySymbol='£']
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
        laundrySubtotal: laundry,
        orderSummary: {
            laundrySubtotal: laundry,
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

module.exports = {
    buildPaymentSummary,
    roundMoney,
};

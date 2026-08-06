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

/**
 * Resolve how the delivery balance should be collected.
 * Cash bookings always cash; card bookings use stored choice or default to card.
 */
function resolveBalancePaymentMethod(booking = {}) {
    const bookingPaymentType = normalizePaymentType(booking.paymentType);
    if (bookingPaymentType === "cash") {
        return "cash";
    }
    const stored = booking.balancePaymentMethod;
    if (stored === "cash" || stored === "card") {
        return stored;
    }
    return "card";
}

function isPaidBillingStatus(status) {
    return String(status || "").trim().toLowerCase() === "paid";
}

/**
 * Cash is only "collected" after recordCashPayment (or explicit confirm).
 * Ignore premature billingDetails.paymentStatus = Paid from older proceed bugs.
 */
function isCashCollectionComplete(options = {}) {
    if (Boolean(options.paymentConfirmed)) return true;
    if (options.balanceCollectedVia === "cash") return true;
    return false;
}

/**
 * Add agent/customer-facing payment state labels for invoice & order history.
 */
function enrichPaymentSummary(paymentSummary, options = {}) {
    const paymentType = normalizePaymentType(options.paymentType);
    const balancePaymentMethod = resolveBalancePaymentMethod({
        paymentType,
        balancePaymentMethod: options.balancePaymentMethod,
    });
    const rawBillingStatus = options.billingPaymentStatus || "Pending";
    const balanceCollectedVia = options.balanceCollectedVia || null;
    const paymentConfirmed = Boolean(options.paymentConfirmed);

    const calculatedDue = roundMoney(paymentSummary.amountDueNow);
    const totalOrderAmount = roundMoney(
        paymentSummary.orderSummary?.totalOrderAmount || 0
    );
    const upfrontPaid = roundMoney(paymentSummary.paidAtBooking?.totalPaid || 0);
    const discount = roundMoney(paymentSummary.orderSummary?.discount || 0);

    const isBillingPaid = isPaidBillingStatus(rawBillingStatus);
    const cashStillDue =
        paymentType === "cash" &&
        !isCashCollectionComplete({ paymentConfirmed, balanceCollectedVia }) &&
        calculatedDue > 0.02;

    // Don't zero amountDueNow for cash COD when billing was marked Paid early
    const isFullyPaid = cashStillDue ? false : isBillingPaid;
    const displayAmountDueNow = isFullyPaid ? 0 : calculatedDue;
    const billingPaymentStatus = cashStillDue ? "Pending" : rawBillingStatus;

    let laterPaid = 0;
    if (isFullyPaid) {
        if (paymentType === "cash") {
            laterPaid = roundMoney(Math.max(0, totalOrderAmount - discount));
        } else if (upfrontPaid > 0) {
            laterPaid = roundMoney(
                Math.max(0, totalOrderAmount - upfrontPaid - discount)
            );
        }
    }

    let paymentState = "balance_due";
    let paymentStateLabel = `Balance due — collect by ${balancePaymentMethod}`;

    if (isFullyPaid) {
        paymentState = "fully_paid";
        paymentStateLabel = "Paid";
    } else if (
        paymentType === "cash" &&
        upfrontPaid <= 0 &&
        calculatedDue > 0
    ) {
        paymentState = "cash_not_collected";
        paymentStateLabel = "Cash selected — not yet collected";
    } else if (
        paymentType === "card" &&
        upfrontPaid > 0 &&
        calculatedDue > 0
    ) {
        paymentState = "card_upfront_balance_due";
        paymentStateLabel =
            balancePaymentMethod === "cash"
                ? "Card paid upfront — balance due in cash"
                : "Card paid upfront — balance due by card";
    }

    const paidAtBooking = {
        ...paymentSummary.paidAtBooking,
        method:
            paymentType === "card" && upfrontPaid > 0 ? "card" : null,
        label:
            paymentType === "card" && upfrontPaid > 0
                ? "Paid by card"
                : null,
    };

    const laterMethod =
        laterPaid > 0
            ? balanceCollectedVia || balancePaymentMethod
            : null;
    const laterLabel =
        laterPaid > 0
            ? laterMethod === "cash"
                ? "Paid in cash"
                : "Paid by card"
            : null;

    const paidLater = {
        totalPaid: laterPaid,
        method: laterMethod,
        label: laterLabel,
    };

    return {
        ...paymentSummary,
        paymentType,
        amountDueNow: displayAmountDueNow,
        balancePaymentMethod,
        balanceCollectedVia,
        billingPaymentStatus,
        paymentState,
        paymentStateLabel,
        paidAtBooking,
        paidLater,
        cashRemaining:
            !isFullyPaid &&
            (balancePaymentMethod === "cash" || paymentType === "cash"),
        balanceCollectionLabel: isFullyPaid
            ? null
            : balancePaymentMethod === "cash"
              ? "Collect balance in cash"
              : "Collect balance by card",
    };
}

/** Driver reached / delivery complete stages where agent should Collect cash. */
const CASH_COLLECT_STATUS_IDS = new Set([14, 15, 16, 17]);

/**
 * Agent-app flags for cash COD (pay after delivery) vs card pay-before-process.
 *
 * @param {object} options
 * @param {string} [options.paymentType]
 * @param {boolean} [options.paymentConfirmed]
 * @param {number} [options.amountDueNow]
 * @param {string} [options.balancePaymentMethod]
 * @param {string} [options.billingPaymentStatus]
 * @param {number} [options.bookingStatusId]
 * @param {string} [options.balanceCollectedVia]
 */
function buildCollectPaymentFlags(options = {}) {
    const paymentType = normalizePaymentType(options.paymentType);
    const balancePaymentMethod = resolveBalancePaymentMethod({
        paymentType,
        balancePaymentMethod: options.balancePaymentMethod,
    });
    const billingPaymentStatus = options.billingPaymentStatus || "Pending";
    const amountDueNow = roundMoney(options.amountDueNow || 0);
    const isBillingPaid = isPaidBillingStatus(billingPaymentStatus);
    const explicitlyConfirmed = Boolean(options.paymentConfirmed);
    const isCashBooking = paymentType === "cash";
    const cashCollected = isCashCollectionComplete({
        paymentConfirmed: explicitlyConfirmed,
        balanceCollectedVia: options.balanceCollectedVia,
    });

    // Cash COD: paymentConfirmed (or balanceCollectedVia) is source of truth — not premature Paid
    const unpaid = isCashBooking
        ? !cashCollected || amountDueNow > 0.02
        : (!isBillingPaid && amountDueNow > 0.02) ||
          (balancePaymentMethod === "cash" &&
              !cashCollected &&
              amountDueNow > 0.02);

    const collectCashAtDelivery =
        unpaid && (isCashBooking || balancePaymentMethod === "cash");

    const statusId = Number(options.bookingStatusId);
    const hasStatus = Number.isFinite(statusId) && statusId > 0;
    const atCollectStage = hasStatus && CASH_COLLECT_STATUS_IDS.has(statusId);

    // Card balance is auto-charged ~2h after invoice finalize — agent proceeds without collect sheet.
    const cardAutoChargeFlow =
        !isCashBooking && balancePaymentMethod === "card";

    return {
        paymentType,
        paymentConfirmed: !unpaid && (cashCollected || isBillingPaid),
        collectPaymentAfterDelivery: collectCashAtDelivery,
        canProceedWithoutPayment:
            isCashBooking ||
            !unpaid ||
            balancePaymentMethod === "cash" ||
            cardAutoChargeFlow,
        // Card: no collect sheet at invoice (auto-charge). Cash COD: collect at delivery stage.
        canCollectPaymentNow:
            !cardAutoChargeFlow &&
            collectCashAtDelivery &&
            (!hasStatus || atCollectStage),
        invoicePaymentWindowApplies: paymentType === "card" && !cardAutoChargeFlow,
        amountDueNow: unpaid ? amountDueNow : 0,
        collectPaymentSheetAtInvoice: false,
    };
}

module.exports = {
    buildPaymentSummary,
    buildCashPaymentSummary,
    buildPaymentSummaryForBooking,
    normalizePaymentType,
    resolveBalancePaymentMethod,
    enrichPaymentSummary,
    buildCollectPaymentFlags,
    roundMoney,
};

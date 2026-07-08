/**
 * Stripe PaymentIntent description + metadata builders for reporting and support.
 */

const CHARGE_TYPE_LABELS = {
    pickup: "Pickup upfront charge",
    booking_auth_hold: "Booking authorization hold",
    delivery_balance: "Delivery balance",
    cancellation_fee: "Cancellation fee",
    reschedule_fee: "Reschedule fee",
};

const PAYMENT_STAGE = {
    pickup: "upfront_at_pickup",
    booking_auth_hold: "auth_hold_at_booking",
    delivery_balance: "balance_at_delivery",
    cancellation_fee: "cancellation_penalty",
    reschedule_fee: "reschedule_penalty",
};

const STATEMENT_SUFFIX = {
    pickup: "PICKUP",
    booking_auth_hold: "HOLD",
    delivery_balance: "LAUNDRY",
    cancellation_fee: "CANCEL",
    reschedule_fee: "RESCHED",
};

function formatPersonName(firstName, lastName) {
    return [firstName, lastName].filter(Boolean).join(" ").trim();
}

function formatPersonDisplay(person, fallbackLabel = "User") {
    const name = formatPersonName(person.firstName, person.lastName);
    const id = person.id != null ? String(person.id) : "";
    if (name && id) {
        return `${name} (ID: ${id})`;
    }
    if (name) {
        return name;
    }
    if (id) {
        return `${fallbackLabel} ID: ${id}`;
    }
    return "";
}

function roundMoneyString(value) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return "0.00";
    return n.toFixed(2);
}

/**
 * @param {object} params
 * @returns {{ description: string, metadata: object, statementDescriptorSuffix: string }}
 */
function buildStripeChargePresentation({
    chargeType,
    bookingId,
    orderTrackId,
    amount,
    currency = "GBP",
    paymentType = "card",
    customer = {},
    agent = {},
    billing = {},
    zoneId = null,
    laundryShopId = null,
    extra = {},
}) {
    const orderLabel = orderTrackId || (bookingId != null ? String(bookingId) : "");
    const customerName = formatPersonName(customer.firstName, customer.lastName);
    const agentName = formatPersonName(agent.firstName, agent.lastName);
    const chargeLabel = CHARGE_TYPE_LABELS[chargeType] || chargeType;
    const amountStr = roundMoneyString(amount);

    const descriptionParts = [chargeLabel, `Order ${orderLabel}`];
    if (customerName) {
        descriptionParts.push(customerName);
    }
    const description = descriptionParts.join(" - ");

    const metadata = {
        platform: "just_dry_cleaners",
        chargeType,
        paymentStage: PAYMENT_STAGE[chargeType] || chargeType,
        isUpfrontPayment: chargeType === "pickup" ? "yes" : "no",
        amount: amountStr,
        currency: String(currency || "GBP").toUpperCase(),
        bookingId: bookingId != null ? String(bookingId) : "",
        orderTrackId: orderTrackId || "",
        paymentType: paymentType || "card",
        customerId: customer.id != null ? String(customer.id) : "",
        customerName,
        customerDisplay: formatPersonDisplay(customer, "Customer"),
        customerEmail: customer.email || "",
        agentId: agent.id != null ? String(agent.id) : "",
        agentName,
        agentDisplay: formatPersonDisplay(agent, "Agent"),
        agentEmail: agent.email || "",
    };

    if (zoneId != null && zoneId !== "") {
        metadata.zoneId = String(zoneId);
    }
    if (laundryShopId != null && laundryShopId !== "") {
        metadata.laundryShopId = String(laundryShopId);
    }

    if (chargeType === "pickup" || chargeType === "booking_auth_hold") {
        const upfront = roundMoneyString(billing.upfrontAmount);
        const serviceFee = roundMoneyString(billing.serviceFee);
        const driverTip = roundMoneyString(billing.driverTip);
        metadata.upfrontAmount = upfront;
        metadata.serviceFee = serviceFee;
        metadata.driverTip = driverTip;
        metadata.chargeBreakdown = `min_${upfront}_fee_${serviceFee}_tip_${driverTip}`;
        metadata.chargeIncludes =
            chargeType === "booking_auth_hold"
                ? "auth_hold_minimum_order_payment_service_fee_driver_tip"
                : "minimum_order_payment_service_fee_driver_tip";
        metadata.upfrontPaymentLabel =
            chargeType === "booking_auth_hold"
                ? "Authorization hold at booking — capture at On the Way"
                : "Yes — minimum deposit + service fee + driver tip at pickup";
        metadata.isUpfrontPayment =
            chargeType === "pickup" ? "yes" : "hold";
    }

    if (chargeType === "delivery_balance") {
        metadata.balanceDue = amountStr;
        metadata.chargeIncludes = "remaining_order_balance_after_pickup";
        if (billing.totalOrderAmount != null) {
            metadata.totalOrderAmount = roundMoneyString(
                billing.totalOrderAmount
            );
        }
    }

    if (chargeType === "cancellation_fee") {
        metadata.cancellationFee = amountStr;
    }

    if (chargeType === "reschedule_fee") {
        metadata.rescheduleFee = amountStr;
        if (extra.rescheduledCount != null) {
            metadata.rescheduledCount = String(extra.rescheduledCount);
        }
    }

    if (extra && typeof extra === "object") {
        for (const [key, value] of Object.entries(extra)) {
            if (value != null && value !== "" && metadata[key] === undefined) {
                metadata[key] = String(value);
            }
        }
    }

    return {
        description,
        metadata,
        statementDescriptorSuffix: STATEMENT_SUFFIX[chargeType] || "LAUNDRY",
    };
}

module.exports = {
    buildStripeChargePresentation,
    formatPersonName,
};

/**
 * Mask phone numbers in agent-facing API responses.
 * Real number stays server-side only (Twilio notify/call).
 */

function maskPhoneNumber(raw) {
    if (raw == null) return null;
    const phone = String(raw).trim();
    if (!phone) return null;
    if (phone.length <= 6) return "****";
    const start = phone.startsWith("+") ? phone.slice(0, 3) : phone.slice(0, 2);
    const end = phone.slice(-3);
    return `${start}****${end}`;
}

/**
 * Redact customer.phoneNum on a plain object (mutates and returns).
 * Keeps a display mask + flags for Call/SMS UI.
 */
function redactCustomerPhone(customer) {
    if (!customer || typeof customer !== "object") return customer;

    const plain = typeof customer.toJSON === "function" ? customer.toJSON() : customer;
    const original = plain.phoneNum;
    const hasPhone = Boolean(original && String(original).trim());

    plain.phoneNum = hasPhone ? maskPhoneNumber(original) : null;
    plain.phoneMasked = true;
    plain.hasPhone = hasPhone;
    // Never expose raw
    delete plain.phoneNumber;
    delete plain.mobile;

    return plain;
}

/**
 * Walk common agent payload shapes and redact nested customer phones.
 */
function redactCustomerPhonesInPayload(payload) {
    if (!payload || typeof payload !== "object") return payload;

    if (Array.isArray(payload)) {
        return payload.map((item) => redactCustomerPhonesInPayload(item));
    }

    if (payload.customer) {
        payload.customer = redactCustomerPhone(payload.customer);
    }

    if (payload.invoiceDetails?.customer) {
        payload.invoiceDetails.customer = redactCustomerPhone(
            payload.invoiceDetails.customer
        );
    }

    if (payload.bookingfind?.customer) {
        payload.bookingfind.customer = redactCustomerPhone(
            payload.bookingfind.customer
        );
    }

    // Lists of bookings
    for (const key of [
        "orders",
        "bookings",
        "All",
        "slots",
        "active",
        "completed",
        "pending",
        "rows",
        "data",
    ]) {
        if (Array.isArray(payload[key])) {
            payload[key] = payload[key].map((item) =>
                redactCustomerPhonesInPayload(item)
            );
        }
    }

    return payload;
}

module.exports = {
    maskPhoneNumber,
    redactCustomerPhone,
    redactCustomerPhonesInPayload,
};

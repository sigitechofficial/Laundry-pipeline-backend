'use strict';

const { redactCustomerPhone } = require('./maskPhone');

/** Phone mask + hide email / Stripe id from field staff. */
function redactCustomerForFieldStaff(customer) {
    const plain = redactCustomerPhone(customer);
    if (!plain || typeof plain !== 'object') return plain;
    plain.email = null;
    delete plain.stripeCustomerId;
    return plain;
}

function stripPricesFromServices(services) {
    if (!Array.isArray(services)) return [];
    return services.map((s) => {
        const row = { ...s };
        row.categoryPrice = null;
        if (row.subCategory && typeof row.subCategory === 'object') {
            row.subCategory = { ...row.subCategory, price: null };
        }
        if (Array.isArray(row.addOns)) {
            row.addOns = row.addOns.map((a) => ({ ...a, price: null }));
        }
        if (Array.isArray(row.repairItems)) {
            row.repairItems = stripRepairOptionPrices(row.repairItems);
        }
        return row;
    });
}

function stripRepairOptionPrices(items) {
    if (!Array.isArray(items)) return [];
    return items.map((item) => ({
        ...item,
        options: Array.isArray(item.options)
            ? item.options.map((o) => ({ ...o, price: 0 }))
            : [],
    }));
}

/**
 * Hide shop finance from a booking payload.
 * Keep collect flags / amountDueNow for COD on delivery.
 *
 * @param {object} plain
 * @param {{ keepDeclared?: boolean, keepLiveServices?: boolean }} [options]
 */
function hideShopFinanceOnBooking(plain, options = {}) {
    if (!plain || typeof plain !== 'object') return plain;

    const keepDeclared = options.keepDeclared === true;
    const keepLiveServices = options.keepLiveServices === true;

    if (plain.customer) {
        plain.customer = redactCustomerForFieldStaff(plain.customer);
    }

    if (keepDeclared) {
        plain.customerDeclaredServices = stripPricesFromServices(
            plain.customerDeclaredServices
        );
        plain.repairItems = stripRepairOptionPrices(plain.repairItems);
        const declared = plain.customerDeclaredServices || [];
        plain.totalItems = declared.reduce((sum, s) => {
            const n = Number(s?.items);
            return sum + (Number.isFinite(n) && n > 0 ? n : 0);
        }, 0);
    } else {
        plain.customerDeclaredServices = [];
        plain.repairItems = [];
    }

    if (!keepLiveServices) {
        plain.customerSelectedServices = [];
    } else {
        plain.customerSelectedServices = stripPricesFromServices(
            plain.customerSelectedServices
        );
    }

    plain.servicesSubtotal = 0;
    plain.orderAmount = 0;
    plain.subTotal = 0;
    plain.invoiceStatus = null;
    plain.invoiceDraftSavedAt = null;

    if (plain.billingDetail && typeof plain.billingDetail === 'object') {
        const due = plain.billingDetail.balanceDue;
        plain.billingDetail = {
            paymentStatus: null,
            balanceDue: due ?? 0,
            total: null,
            upfrontAmount: null,
            serviceCharge: null,
            discount: null,
            agentEarning: null,
            zoneAdminCommission: null,
            pickupDriverEarning: null,
            deliveryDriverEarning: null,
        };
    }

    plain.extraTip = null;
    plain.tips = [];

    if (plain.paymentSummary && typeof plain.paymentSummary === 'object') {
        plain.paymentSummary = {
            paymentType: plain.paymentSummary.paymentType,
            canCollectPaymentNow: plain.paymentSummary.canCollectPaymentNow,
            collectPaymentAfterDelivery:
                plain.paymentSummary.collectPaymentAfterDelivery,
            canProceedWithoutPayment:
                plain.paymentSummary.canProceedWithoutPayment,
            invoicePaymentWindowApplies:
                plain.paymentSummary.invoicePaymentWindowApplies,
            amountDueNow: plain.paymentSummary.amountDueNow,
        };
    }

    return plain;
}

function slimPaymentSummaryForFieldStaff(summary, flags = {}) {
    if (!summary || typeof summary !== 'object') {
        return {
            amountDueNow: flags.amountDueNow ?? 0,
            ...flags,
        };
    }
    return {
        paymentType: summary.paymentType ?? flags.paymentType,
        canCollectPaymentNow:
            summary.canCollectPaymentNow ?? flags.canCollectPaymentNow,
        collectPaymentAfterDelivery:
            summary.collectPaymentAfterDelivery ??
            flags.collectPaymentAfterDelivery,
        canProceedWithoutPayment:
            summary.canProceedWithoutPayment ?? flags.canProceedWithoutPayment,
        invoicePaymentWindowApplies:
            summary.invoicePaymentWindowApplies ??
            flags.invoicePaymentWindowApplies,
        amountDueNow: summary.amountDueNow ?? flags.amountDueNow ?? 0,
        ...flags,
    };
}

module.exports = {
    redactCustomerForFieldStaff,
    hideShopFinanceOnBooking,
    slimPaymentSummaryForFieldStaff,
    stripPricesFromServices,
};

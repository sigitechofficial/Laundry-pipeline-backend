"use strict";

const assert = require("assert");
const {
    buildPaymentSummaryForBooking,
    resolvePrepaidDriverTip,
    lockPrepaidTipAmount,
} = require("./invoicePaymentSummary");

function runTests() {
    assert.strictEqual(resolvePrepaidDriverTip("cash", 10, 99), 0);
    assert.strictEqual(resolvePrepaidDriverTip("card", 10, null), 10, "legacy: current tip is prepaid");
    assert.strictEqual(resolvePrepaidDriverTip("card", 10, 0), 0, "admin-added tip was not collected at pickup");

    assert.strictEqual(lockPrepaidTipAmount("card", null, 0), 0);
    assert.strictEqual(lockPrepaidTipAmount("card", null, 5), 5);
    assert.strictEqual(lockPrepaidTipAmount("card", 5, 10), 5, "do not overwrite locked prepaid tip");
    assert.strictEqual(lockPrepaidTipAmount("cash", null, 8), 0);

    const adminAddedTip = buildPaymentSummaryForBooking("card", {
        laundrySubtotal: 100,
        serviceFee: 30,
        minimumOrderPayment: 20,
        driverTip: 10,
        prepaidDriverTip: 0,
        discount: 0,
    });
    assert.strictEqual(adminAddedTip.orderSummary.totalOrderAmount, 140);
    assert.strictEqual(adminAddedTip.orderSummary.driverTip, 10);
    assert.strictEqual(adminAddedTip.paidAtBooking.driverTip, 0);
    assert.strictEqual(adminAddedTip.paidAtBooking.totalPaid, 50);
    assert.strictEqual(
        adminAddedTip.amountDueNow,
        90,
        "invoice remaining must include unpaid admin tip"
    );

    const checkoutTip = buildPaymentSummaryForBooking("card", {
        laundrySubtotal: 100,
        serviceFee: 30,
        minimumOrderPayment: 20,
        driverTip: 5,
        prepaidDriverTip: 5,
    });
    assert.strictEqual(checkoutTip.amountDueNow, 80, "prepaid checkout tip must not be billed twice");

    const legacy = buildPaymentSummaryForBooking("card", {
        laundrySubtotal: 100,
        serviceFee: 30,
        minimumOrderPayment: 20,
        driverTip: 10,
    });
    assert.strictEqual(legacy.amountDueNow, 80, "legacy card still treats current tip as prepaid");

    const raisedTip = buildPaymentSummaryForBooking("card", {
        laundrySubtotal: 100,
        serviceFee: 30,
        minimumOrderPayment: 20,
        driverTip: 12,
        prepaidDriverTip: 5,
    });
    assert.strictEqual(raisedTip.amountDueNow, 87, "only the unpaid tip delta is due");

    const cash = buildPaymentSummaryForBooking("cash", {
        laundrySubtotal: 100,
        serviceFee: 30,
        minimumOrderPayment: 20,
        driverTip: 10,
    });
    assert.strictEqual(cash.orderSummary.totalOrderAmount, 140);
    assert.strictEqual(cash.amountDueNow, 140);
    assert.strictEqual(cash.paidAtBooking.driverTip, 0);

    console.log("invoicePaymentSummary.test.js: all assertions passed");
}

runTests();

"use strict";

const { Op } = require("sequelize");
const {
    booking,
    billingDetails,
    users,
    addressDb,
    bussinessInformation,
    zone,
    invoicePaymentAttempt,
} = require("../../models");
const {
    normalizePaymentType,
    resolveBalancePaymentMethod,
    roundMoney,
} = require("../../utils/invoicePaymentSummary");
const { COMPLETED } = require("../../constants/bookingStatusIds");
const invoiceManagementService = require("./invoiceManagementService");
const { chargeOffSession } = require("../../controllers/stripe");
const { buildStripeChargePresentation } = require("../../utils/stripePaymentMetadata");
const { sendNotification } = require("../../utils/notification");
const { creditAgentForPaidBooking } = require("./agentWalletService");
const {
    formatPaymentFailureReason,
} = require("../../utils/paymentFailureLabels");
const {
    buildOrderListSequelizeOrder,
    PAYMENT_FAILURE_SORT_FIELDS,
    DEFAULT_PAYMENT_FAILURE_SORT,
} = require("../../utils/orderListSort");
const { resolveListWindow, buildPagination } = require("../../utils/listQuery");
const {
    buildPaymentFailureListWhere,
    PAYMENT_FAILURE_DEFAULT_LIMIT,
} = require("../../utils/adminListFilters");

const runtimeSettingsService = require("../Admin/runtimeSettingsService");

const ENV_AUTO_CHARGE_DELAY_MS = Number(
    process.env.INVOICE_AUTO_CHARGE_DELAY_MS || 2 * 60 * 60 * 1000
);
const ENV_AUTO_CHARGE_JOB_INTERVAL_MS = Number(
    process.env.INVOICE_AUTO_CHARGE_JOB_INTERVAL_MS || 60 * 1000
);

async function getAutoChargeConfig() {
    const [
        enabled,
        delayMs,
        intervalMs,
        maxAttempts,
        retryGapMs,
    ] = await Promise.all([
        runtimeSettingsService.getBoolean("invoiceAutoChargeEnabled"),
        runtimeSettingsService.getInteger("invoiceAutoChargeDelayMs"),
        runtimeSettingsService.getInteger("invoiceAutoChargeJobIntervalMs"),
        runtimeSettingsService.getInteger("invoiceAutoChargeMaxAttempts"),
        runtimeSettingsService.getInteger("invoiceAutoChargeRetryGapMs"),
    ]);
    return { enabled, delayMs, intervalMs, maxAttempts, retryGapMs };
}

let autoChargeTimer = null;

function isCardBalanceDue(bookingRow, amountDueNow) {
    const paymentType = normalizePaymentType(bookingRow.paymentType);
    if (paymentType !== "card") return false;
    const balanceMethod = resolveBalancePaymentMethod(bookingRow);
    if (balanceMethod === "cash") return false;
    return roundMoney(amountDueNow) > 0.02;
}

/**
 * Invoice balance settlement only — trust server-calculated amountDueNow.
 * Do NOT use booking.paymentConfirmed here: that flag is often set true after
 * pickup auth hold / upfront while the invoice balance is still due.
 */
function isBookingPaid(_bookingRow, amountDueNow) {
    return roundMoney(amountDueNow) <= 0.02;
}

const OFD_WAIT_ADMIN_MESSAGE =
    "Please wait for admin instruction. Payment still needs to be processed.";

function buildPaymentGateFlags(bookingRow = {}, amountDueNow = 0) {
    const paymentType = normalizePaymentType(bookingRow.paymentType);
    const balanceMethod = resolveBalancePaymentMethod(bookingRow);
    const paid = isBookingPaid(bookingRow, amountDueNow);
    const gate = bookingRow.paymentDeliveryGate || "open";
    const failed =
        !paid &&
        paymentType === "card" &&
        balanceMethod === "card" &&
        (bookingRow.autoChargeStatus === "failed" || gate === "waiting_admin");
    const waitingAdmin = !paid && gate === "waiting_admin";
    const clearedCash = gate === "cleared_cash" || balanceMethod === "cash";
    const clearedAllow = gate === "cleared_allow";
    // Unpaid card with an open gate may still attempt OFD (server charges once,
    // then holds for admin). Hard-block only while waiting_admin.
    const canOutForDelivery =
        paid ||
        paymentType === "cash" ||
        clearedCash ||
        clearedAllow ||
        (paymentType === "card" && balanceMethod === "cash") ||
        (paymentType === "card" &&
            balanceMethod === "card" &&
            !waitingAdmin &&
            gate === "open");

    const failureCode = bookingRow.lastPaymentFailureCode || null;
    const rawFailureMessage = bookingRow.lastPaymentFailureMessage || null;
    const failureReason = failed
        ? formatPaymentFailureReason(failureCode, rawFailureMessage)
        : null;

    return {
        autoChargeStatus: bookingRow.autoChargeStatus || "none",
        autoChargeDueAt: bookingRow.autoChargeDueAt || null,
        paymentFailed: failed,
        paymentFailureCode: failureCode,
        paymentFailureReason: waitingAdmin
            ? failureReason || OFD_WAIT_ADMIN_MESSAGE
            : failureReason,
        paymentFailureRawMessage: rawFailureMessage,
        paymentFailureAt: bookingRow.lastPaymentFailureAt || null,
        paymentWaitingAdmin: waitingAdmin,
        paymentDeliveryGate: gate,
        paymentAdminNotes: bookingRow.paymentAdminNotes || null,
        canOutForDelivery,
        collectPaymentSheetAtInvoice: false,
    };
}

/**
 * Schedule 2h auto-charge after invoice finalize (card balance only).
 */
async function scheduleInvoiceAutoCharge(bookingId, options = {}) {
    const bookingRow = await booking.findByPk(bookingId, {
        include: [
            {
                model: billingDetails,
                as: "billingDetail",
                required: false,
                attributes: ["paymentStatus", "total"],
            },
        ],
    });
    if (!bookingRow) return null;

    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const amountDue = paymentSummary?.amountDueNow ?? 0;

    if (!isCardBalanceDue(bookingRow, amountDue)) {
        await bookingRow.update({
            invoiceFinalizedAt: bookingRow.invoiceFinalizedAt || new Date(),
            autoChargeStatus: "skipped",
            autoChargeDueAt: null,
            paymentDeliveryGate: "open",
        });
        return buildPaymentGateFlags(bookingRow, amountDue);
    }

    const autoChargeCfg = await getAutoChargeConfig();
    if (!autoChargeCfg.enabled) {
        console.log(
            `[invoiceAutoCharge] disabled — not scheduling booking ${bookingId}`
        );
        return buildPaymentGateFlags(bookingRow, amountDue);
    }

    if (bookingRow.autoChargeStatus === "succeeded" || isBookingPaid(bookingRow, amountDue)) {
        if (
            isBookingPaid(bookingRow, amountDue) &&
            bookingRow.autoChargeStatus !== "succeeded" &&
            bookingRow.autoChargeStatus !== "skipped"
        ) {
            await bookingRow.update({
                autoChargeStatus: "skipped",
                autoChargeDueAt: null,
            });
        }
        return buildPaymentGateFlags(bookingRow, amountDue);
    }

    // Upfront/hold may have left paymentConfirmed=true while balance remains —
    // still schedule invoice auto-charge (upfront flow unchanged).
    if (Boolean(bookingRow.paymentConfirmed) && amountDue > 0.02) {
        console.log(
            `[invoiceAutoCharge] booking ${bookingId} has paymentConfirmed=true but amountDue=${amountDue} — scheduling balance charge`
        );
    }

    if (
        bookingRow.autoChargeStatus === "scheduled" &&
        bookingRow.autoChargeDueAt &&
        !options.forceReschedule
    ) {
        return buildPaymentGateFlags(bookingRow, amountDue);
    }

    const finalizedAt = options.finalizedAt || new Date();
    const dueAt = new Date(finalizedAt.getTime() + autoChargeCfg.delayMs);

    await bookingRow.update({
        invoiceFinalizedAt: bookingRow.invoiceFinalizedAt || finalizedAt,
        autoChargeStatus: "scheduled",
        autoChargeDueAt: dueAt,
        ofdAutoRetryDone: false,
        paymentDeliveryGate: "open",
        lastPaymentFailureCode: null,
        lastPaymentFailureMessage: null,
        lastPaymentFailureAt: null,
    });

    await bookingRow.reload();
    console.log(
        `[invoiceAutoCharge] booking ${bookingId} scheduled for ${dueAt.toISOString()}`
    );
    return buildPaymentGateFlags(bookingRow, amountDue);
}

async function resolveStripeCustomerAndPm(bookingRow) {
    const customer = bookingRow.customer ||
        (await users.findByPk(bookingRow.customerId, {
            attributes: [
                "id",
                "firstName",
                "lastName",
                "email",
                "stripeCustomerId",
                "defaultPaymentMethodId",
            ],
        }));

    const stripeCustomerId = customer?.stripeCustomerId || null;
    const paymentMethodId =
        bookingRow.paymentMethodId ||
        customer?.defaultPaymentMethodId ||
        null;

    return { customer, stripeCustomerId, paymentMethodId };
}

async function resolveAgentUserId(bookingRow) {
    if (bookingRow.driverId) return bookingRow.driverId;
    if (!bookingRow.laundryShopId) return null;
    const shop = await addressDb.findByPk(bookingRow.laundryShopId, {
        attributes: ["id", "userId"],
    });
    return shop?.userId || null;
}

function extractStripeError(err) {
    const raw = err?.raw || err?.original || err;
    const stripeCode =
        err?.stripeCode ||
        raw?.code ||
        err?.code ||
        null;
    const declineCode =
        err?.declineCode ||
        raw?.decline_code ||
        null;
    let message = err?.message || "Payment failed";
    if (message.startsWith("Stripe Error: ")) {
        message = message.replace("Stripe Error: ", "");
    }
    return {
        stripeCode: stripeCode ? String(stripeCode).slice(0, 64) : null,
        declineCode: declineCode ? String(declineCode).slice(0, 64) : null,
        message: String(message).slice(0, 500),
    };
}

function resolvePickupPaymentIntentId(bookingRow, incomingPaymentIntentId) {
    const stored = bookingRow.pickupPaymentIntentId;
    if (stored) return stored;
    const current = bookingRow.paymentIntentId;
    if (current && current !== incomingPaymentIntentId) return current;
    return null;
}

async function markChargeSuccess(bookingRow, paymentIntent, amount, paymentSummary) {
    const fullOrderTotal =
        paymentSummary?.orderSummary?.totalOrderAmount ?? amount;
    const pickupPaymentIntentId = resolvePickupPaymentIntentId(
        bookingRow,
        paymentIntent.id
    );

    await billingDetails.update(
        {
            total: fullOrderTotal,
            paymentStatus: "Paid",
        },
        { where: { bookingId: bookingRow.id } }
    );

    const invoiceSuccessUpdate = {
        orderAmount: fullOrderTotal,
        paymentIntentId: paymentIntent.id,
        balanceCollectedVia: "card",
        paymentConfirmed: true,
        autoChargeStatus: "succeeded",
        paymentDeliveryGate: "open",
        lastPaymentFailureCode: null,
        lastPaymentFailureMessage: null,
        lastPaymentFailureAt: null,
        ofdAutoRetryDone: false,
    };
    if (pickupPaymentIntentId) {
        invoiceSuccessUpdate.pickupPaymentIntentId = pickupPaymentIntentId;
    }

    await booking.update(invoiceSuccessUpdate, { where: { id: bookingRow.id } });

    try {
        await creditAgentForPaidBooking(bookingRow.id);
    } catch (walletErr) {
        console.error(
            `[invoiceAutoCharge] wallet credit failed booking ${bookingRow.id}:`,
            walletErr.message
        );
    }

    await notifyPaymentSucceeded(bookingRow, amount);
}

async function notifyPaymentSucceeded(bookingRow, amount) {
    const orderLabel = bookingRow.orderTrackId || bookingRow.id;
    const amountLabel = Number(amount || 0).toFixed(2);
    const data = {
        bookingId: String(bookingRow.id),
        type: "PAYMENT_SUCCEEDED",
        orderTrackId: String(bookingRow.orderTrackId || ""),
        amount: String(amountLabel),
    };

    if (bookingRow.customerId) {
        sendNotification(
            bookingRow.customerId,
            "Payment successful",
            `Payment of £${amountLabel} for order ${orderLabel} was successful.`,
            data
        ).catch((e) =>
            console.error(
                "[invoiceAutoCharge] customer success notify failed:",
                e.message
            )
        );
    }

    const agentUserId = await resolveAgentUserId(bookingRow);
    if (agentUserId) {
        sendNotification(
            agentUserId,
            "Payment received",
            `Card payment of £${amountLabel} received for order ${orderLabel}.`,
            data
        ).catch((e) =>
            console.error(
                "[invoiceAutoCharge] agent success notify failed:",
                e.message
            )
        );
    }
}

async function notifyPaymentFailed(bookingRow, failure) {
    const code = failure.declineCode || failure.stripeCode || "payment_failed";
    const reason = formatPaymentFailureReason(code, failure.message);
    const data = {
        bookingId: String(bookingRow.id),
        type: "PAYMENT_FAILED",
        alertType: "payment_failed",
        paymentFailureCode: code,
        paymentFailureReason: reason,
        orderTrackId: bookingRow.orderTrackId || "",
    };

    if (bookingRow.customerId) {
        sendNotification(
            bookingRow.customerId,
            "Payment failed",
            `Payment for order ${bookingRow.orderTrackId || bookingRow.id} failed: ${reason}. Please contact support if you want to pay by cash.`,
            data
        ).catch((e) =>
            console.error("[invoiceAutoCharge] customer notify failed:", e.message)
        );
    }

    const agentUserId = await resolveAgentUserId(bookingRow);
    if (agentUserId) {
        sendNotification(
            agentUserId,
            "Please wait for admin instruction",
            `Order ${bookingRow.orderTrackId || bookingRow.id}: ${OFD_WAIT_ADMIN_MESSAGE} (${reason})`,
            data
        ).catch((e) =>
            console.error("[invoiceAutoCharge] agent notify failed:", e.message)
        );
    }

    const { sendAdminAlert } = require("../Admin/adminAlertService");
    sendAdminAlert({
        alertType: "payment_failed",
        title: "Payment needs admin — delivery held",
        body: `Order ${bookingRow.orderTrackId || bookingRow.id}: ${reason}. Flagged until payment is resolved (Payment Failures).`,
        data,
        bookingId: bookingRow.id,
    }).catch((e) =>
        console.error("[invoiceAutoCharge] admin notify failed:", e.message)
    );
}

/**
 * Delivery held for unpaid/unprocessed card — flag admin even when no new Stripe error.
 */
async function notifyPaymentAwaitingAdmin(bookingRow, reason = null) {
    const displayReason = reason || OFD_WAIT_ADMIN_MESSAGE;
    const data = {
        bookingId: String(bookingRow.id),
        type: "PAYMENT_WAITING_ADMIN",
        alertType: "payment_failed",
        paymentFailureReason: displayReason,
        orderTrackId: bookingRow.orderTrackId || "",
        paymentDeliveryGate: "waiting_admin",
    };

    const agentUserId = await resolveAgentUserId(bookingRow);
    if (agentUserId) {
        sendNotification(
            agentUserId,
            "Please wait for admin instruction",
            `Order ${bookingRow.orderTrackId || bookingRow.id}: ${OFD_WAIT_ADMIN_MESSAGE}`,
            data
        ).catch((e) =>
            console.error(
                "[invoiceAutoCharge] agent awaiting-admin notify failed:",
                e.message
            )
        );
    }

    const { sendAdminAlert } = require("../Admin/adminAlertService");
    sendAdminAlert({
        alertType: "payment_failed",
        title: "Order flagged — payment not processed",
        body: `Order ${bookingRow.orderTrackId || bookingRow.id}: card payment not processed. Delivery held until admin resolves.`,
        data,
        bookingId: bookingRow.id,
    }).catch((e) =>
        console.error(
            "[invoiceAutoCharge] admin awaiting-admin notify failed:",
            e.message
        )
    );
}

async function notifyPaymentCleared(bookingRow, action) {
    const agentUserId = await resolveAgentUserId(bookingRow);
    if (!agentUserId) return;
    const label =
        action === "shift_to_cash"
            ? "Admin shifted balance to cash. You can proceed; collect cash at delivery."
            : "Admin cleared payment hold. You can proceed to Out for Delivery.";
    sendNotification(
        agentUserId,
        "Payment hold cleared",
        `Order ${bookingRow.orderTrackId || bookingRow.id}: ${label}`,
        {
            bookingId: String(bookingRow.id),
            type: "PAYMENT_HOLD_CLEARED",
            action,
        }
    ).catch((e) =>
        console.error("[invoiceAutoCharge] clear notify failed:", e.message)
    );
}

/**
 * Attempt card charge for invoice balance.
 * @returns {{ ok: boolean, skipped?: boolean, alreadyPaid?: boolean, paymentIntentId?: string, failure?: object }}
 */
async function attemptInvoiceCardCharge(bookingId, options = {}) {
    const attemptType = options.attemptType || "scheduled_auto";
    const triggeredBy = options.triggeredBy || "system";

    const bookingRow = await booking.findByPk(bookingId, {
        include: [
            {
                model: users,
                as: "customer",
                attributes: [
                    "id",
                    "firstName",
                    "lastName",
                    "email",
                    "stripeCustomerId",
                    "defaultPaymentMethodId",
                ],
            },
            {
                model: billingDetails,
                as: "billingDetail",
                required: false,
                attributes: ["paymentStatus", "total"],
            },
        ],
    });

    if (!bookingRow) {
        return { ok: false, skipped: true, failure: { message: "Booking not found" } };
    }

    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const amountDue = roundMoney(paymentSummary?.amountDueNow ?? 0);

    if (isBookingPaid(bookingRow, amountDue)) {
        if (bookingRow.autoChargeStatus !== "succeeded") {
            await bookingRow.update({
                autoChargeStatus: "succeeded",
                paymentDeliveryGate: "open",
                paymentConfirmed: true,
            });
        }
        return { ok: true, alreadyPaid: true };
    }

    if (!isCardBalanceDue(bookingRow, amountDue)) {
        await invoicePaymentAttempt.create({
            bookingId,
            attemptType,
            attemptNumber: (bookingRow.autoChargeAttemptCount || 0) + 1,
            status: "skipped",
            amount: amountDue,
            errorMessage: "Not a card balance due booking",
            laundryShopId: bookingRow.laundryShopId,
            triggeredBy,
        });
        return { ok: true, skipped: true };
    }

    const { customer, stripeCustomerId, paymentMethodId } =
        await resolveStripeCustomerAndPm(bookingRow);

    const attemptNumber = (bookingRow.autoChargeAttemptCount || 0) + 1;
    await bookingRow.update({
        autoChargeStatus: "processing",
        autoChargeAttemptCount: attemptNumber,
        autoChargeLastAttemptAt: new Date(),
    });

    if (!stripeCustomerId || !paymentMethodId) {
        const failure = {
            stripeCode: "missing_payment_method",
            declineCode: null,
            message: !stripeCustomerId
                ? "Stripe customer missing"
                : "No saved payment method on file",
        };
        await persistFailure(bookingRow, failure, {
            attemptType,
            attemptNumber,
            amountDue,
            paymentMethodId,
            triggeredBy,
            notify: options.notifyOnFailure !== false,
        });
        return { ok: false, failure };
    }

    const idempotencyKey =
        options.idempotencyKey ||
        `booking_${bookingId}_${attemptType}_${attemptNumber}`;

    try {
        const stripePresentation = buildStripeChargePresentation({
            chargeType: "delivery_balance",
            bookingId,
            orderTrackId: bookingRow.orderTrackId,
            amount: amountDue,
            currency: "GBP",
            paymentType: bookingRow.paymentType || "card",
            customer: customer || { id: bookingRow.customerId },
            agent: { id: options.agentUserId || null },
            billing: {
                totalOrderAmount: paymentSummary?.orderSummary?.totalOrderAmount,
            },
            zoneId: bookingRow.zoneId,
            laundryShopId: bookingRow.laundryShopId,
            extra: {
                auto_charge_attempt: String(attemptNumber),
                auto_charge_type: attemptType,
            },
        });

        const paymentIntent = await chargeOffSession(
            amountDue,
            stripeCustomerId,
            paymentMethodId,
            idempotencyKey,
            stripePresentation
        );

        if (paymentIntent.status !== "succeeded") {
            throw Object.assign(new Error(`Payment status: ${paymentIntent.status}`), {
                stripeCode: paymentIntent.status,
            });
        }

        await markChargeSuccess(bookingRow, paymentIntent, amountDue, paymentSummary);

        await invoicePaymentAttempt.create({
            bookingId,
            attemptType,
            attemptNumber,
            status: "succeeded",
            amount: amountDue,
            paymentMethodId,
            paymentIntentId: paymentIntent.id,
            laundryShopId: bookingRow.laundryShopId,
            agentUserId: options.agentUserId || null,
            triggeredBy,
        });

        console.log(
            `[invoiceAutoCharge] booking ${bookingId} charged OK via ${attemptType}`
        );
        return { ok: true, paymentIntentId: paymentIntent.id };
    } catch (err) {
        const failure = extractStripeError(err);
        await persistFailure(bookingRow, failure, {
            attemptType,
            attemptNumber,
            amountDue,
            paymentMethodId,
            triggeredBy,
            notify: options.notifyOnFailure !== false,
        });
        return { ok: false, failure };
    }
}

async function persistFailure(bookingRow, failure, ctx) {
    const autoChargeCfg = await getAutoChargeConfig();
    const shouldSoftRetry =
        ctx.attemptType === "scheduled_auto" &&
        ctx.attemptNumber < autoChargeCfg.maxAttempts &&
        isRecoverableDecline(failure);

    const nextDue = shouldSoftRetry
        ? new Date(Date.now() + autoChargeCfg.retryGapMs)
        : bookingRow.autoChargeDueAt;

    await booking.update(
        {
            autoChargeStatus: "failed",
            autoChargeDueAt: nextDue,
            lastPaymentFailureCode: failure.declineCode || failure.stripeCode,
            lastPaymentFailureMessage: failure.message,
            lastPaymentFailureAt: new Date(),
            paymentDeliveryGate: shouldSoftRetry ? "open" : "waiting_admin",
        },
        { where: { id: bookingRow.id } }
    );

    await invoicePaymentAttempt.create({
        bookingId: bookingRow.id,
        attemptType: ctx.attemptType,
        attemptNumber: ctx.attemptNumber,
        status: "failed",
        amount: ctx.amountDue,
        paymentMethodId: ctx.paymentMethodId || null,
        stripeErrorCode: failure.stripeCode,
        stripeDeclineCode: failure.declineCode,
        errorMessage: failure.message,
        laundryShopId: bookingRow.laundryShopId,
        agentUserId: ctx.agentUserId || null,
        triggeredBy: ctx.triggeredBy,
        metadata: shouldSoftRetry
            ? { softRetryScheduled: true, nextDue }
            : { awaitingAdmin: true },
    });

    if (ctx.notify && !shouldSoftRetry) {
        const fresh = await booking.findByPk(bookingRow.id);
        await notifyPaymentFailed(fresh || bookingRow, failure);
    }
}

function isRecoverableDecline(failure = {}) {
    const code = String(failure.declineCode || failure.stripeCode || "").toLowerCase();
    const recoverable = new Set([
        "insufficient_funds",
        "card_decline_rate_limit_exceeded",
        "try_again_later",
        "processing_error",
        "temporary_failure",
    ]);
    return recoverable.has(code);
}

/**
 * Cron: charge bookings whose autoChargeDueAt has passed.
 */
async function processDueInvoiceAutoCharges() {
    const autoChargeCfg = await getAutoChargeConfig();
    if (!autoChargeCfg.enabled) {
        return { charged: 0, failed: 0, skipped: 0, disabled: true };
    }

    const now = new Date();
    const stuckProcessingBefore = new Date(now.getTime() - 5 * 60 * 1000);
    const dueBookings = await booking.findAll({
        where: {
            paymentType: "card",
            invoiceStatus: "finalized",
            paymentDeliveryGate: "open",
            bookingStatusId: { [Op.between]: [9, 16] },
            [Op.or]: [
                {
                    autoChargeStatus: { [Op.in]: ["scheduled", "failed"] },
                    autoChargeDueAt: { [Op.lte]: now },
                },
                {
                    // Recover crashed mid-charge
                    autoChargeStatus: "processing",
                    autoChargeLastAttemptAt: { [Op.lte]: stuckProcessingBefore },
                },
            ],
        },
        attributes: ["id", "autoChargeAttemptCount", "autoChargeStatus"],
        limit: 50,
        order: [["autoChargeDueAt", "ASC"]],
    });

    let charged = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of dueBookings) {
        if ((row.autoChargeAttemptCount || 0) >= autoChargeCfg.maxAttempts) {
            if (row.autoChargeStatus !== "failed") {
                await booking.update(
                    { autoChargeStatus: "failed", paymentDeliveryGate: "waiting_admin" },
                    { where: { id: row.id } }
                );
            }
            skipped += 1;
            continue;
        }

        const result = await attemptInvoiceCardCharge(row.id, {
            attemptType: "scheduled_auto",
            triggeredBy: "system",
            notifyOnFailure: true,
        });

        if (result.ok) charged += 1;
        else if (result.skipped) skipped += 1;
        else failed += 1;
    }

    if (dueBookings.length) {
        console.log(
            `[invoiceAutoCharge] job done charged=${charged} failed=${failed} skipped=${skipped}`
        );
    }
    return { charged, failed, skipped, scanned: dueBookings.length };
}

/**
 * Gate Out for Delivery for card unpaid bookings.
 * Auto-retries once at OFD, then blocks until admin clears.
 */
async function assertCanOutForDelivery(bookingId, options = {}) {
    const bookingRow = await booking.findByPk(bookingId, {
        include: [
            {
                model: billingDetails,
                as: "billingDetail",
                required: false,
                attributes: ["paymentStatus", "total"],
            },
            {
                model: users,
                as: "customer",
                attributes: [
                    "id",
                    "stripeCustomerId",
                    "defaultPaymentMethodId",
                    "firstName",
                    "lastName",
                    "email",
                ],
            },
        ],
    });

    if (!bookingRow) {
        const err = new Error("Booking not found");
        err.statusCode = 404;
        throw err;
    }

    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const amountDue = roundMoney(paymentSummary?.amountDueNow ?? 0);
    const paymentType = normalizePaymentType(bookingRow.paymentType);
    const balanceMethod = resolveBalancePaymentMethod(bookingRow);
    const flags = buildPaymentGateFlags(bookingRow, amountDue);

    if (paymentType === "cash" || balanceMethod === "cash") {
        return { allowed: true, flags, paymentSummary };
    }

    if (isBookingPaid(bookingRow, amountDue)) {
        // Clear a stale admin hold once balance is settled (e.g. charge succeeded
        // after an earlier OFD retry had set waiting_admin).
        if (bookingRow.paymentDeliveryGate === "waiting_admin") {
            await booking.update(
                {
                    paymentDeliveryGate: "open",
                    lastPaymentFailureCode: null,
                    lastPaymentFailureMessage: null,
                    lastPaymentFailureAt: null,
                },
                { where: { id: bookingId } }
            );
        }
        return { allowed: true, flags: buildPaymentGateFlags(bookingRow, 0), paymentSummary };
    }

    if (
        bookingRow.paymentDeliveryGate === "cleared_allow" ||
        bookingRow.paymentDeliveryGate === "cleared_cash"
    ) {
        return { allowed: true, flags, paymentSummary };
    }

    // Already held for admin — do not re-attempt charge; agent must wait.
    if (bookingRow.paymentDeliveryGate === "waiting_admin") {
        const err = new Error(OFD_WAIT_ADMIN_MESSAGE);
        err.statusCode = 402;
        err.code = "PAYMENT_WAITING_ADMIN";
        err.paymentFlags = flags;
        throw err;
    }

    // OFD automatic retry (once)
    if (!bookingRow.ofdAutoRetryDone) {
        await bookingRow.update({ ofdAutoRetryDone: true });
        // Include invoice version in key so an edited invoice gets a fresh key.
        const invoiceVersion = bookingRow.invoiceUpdatedAt
            ? new Date(bookingRow.invoiceUpdatedAt).getTime()
            : 'v1';
        const result = await attemptInvoiceCardCharge(bookingId, {
            attemptType: "ofd_retry",
            triggeredBy: "system",
            agentUserId: options.agentUserId,
            notifyOnFailure: true,
            idempotencyKey: `booking_${bookingId}_ofd_retry_${invoiceVersion}`,
        });

        if (result.ok) {
            const paidSummary =
                await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
            const fresh = await booking.findByPk(bookingId);
            return {
                allowed: true,
                chargedOnOfd: true,
                flags: buildPaymentGateFlags(fresh, 0),
                paymentSummary: paidSummary,
            };
        }
    }

    const fresh = await booking.findByPk(bookingId, {
        include: [
            {
                model: billingDetails,
                as: "billingDetail",
                required: false,
                attributes: ["paymentStatus"],
            },
        ],
    });

    const wasAlreadyWaiting = fresh.paymentDeliveryGate === "waiting_admin";
    if (!wasAlreadyWaiting) {
        await fresh.update({
            paymentDeliveryGate: "waiting_admin",
            lastPaymentFailureAt: fresh.lastPaymentFailureAt || new Date(),
            lastPaymentFailureMessage:
                fresh.lastPaymentFailureMessage ||
                "Card payment has not been processed yet",
            lastPaymentFailureCode:
                fresh.lastPaymentFailureCode || "payment_not_processed",
        });
        await notifyPaymentAwaitingAdmin(
            { ...fresh.get({ plain: true }), paymentDeliveryGate: "waiting_admin" },
            fresh.lastPaymentFailureMessage
        );
    }

    const blockedFlags = buildPaymentGateFlags(
        {
            ...fresh.get({ plain: true }),
            paymentDeliveryGate: "waiting_admin",
            lastPaymentFailureCode:
                fresh.lastPaymentFailureCode || "payment_not_processed",
            lastPaymentFailureMessage:
                fresh.lastPaymentFailureMessage ||
                "Card payment has not been processed yet",
        },
        amountDue
    );

    const err = new Error(OFD_WAIT_ADMIN_MESSAGE);
    err.statusCode = 402;
    err.code = "PAYMENT_WAITING_ADMIN";
    err.paymentFlags = blockedFlags;
    throw err;
}

/**
 * Admin payment-failure queue (card auto-charge waiting on an admin decision).
 *
 * Shared list contract (utils/listQuery):
 *   search              orderTrackId / booking id / customer name, email, phone
 *   zoneId              booking zone (forced from JWT for zone staff)
 *   startDate/endDate   inclusive range on lastPaymentFailureAt
 *   sortBy/sortDir      PAYMENT_FAILURE_SORT_FIELDS allowlist
 *   page/limit          default 25; export=1 → whole filtered set (capped)
 */
async function listPaymentFailures(options = {}) {
    const window = resolveListWindow(options, {
        defaultLimit: PAYMENT_FAILURE_DEFAULT_LIMIT,
    });
    const baseWhere = {
        paymentType: "card",
        paymentDeliveryGate: "waiting_admin",
        bookingStatusId: { [Op.lt]: COMPLETED },
    };
    const { where, searchTerm, hasSearch, zoneId } = buildPaymentFailureListWhere(
        baseWhere,
        options,
        { zoneId: options.zoneId }
    );

    const customerInclude = {
        model: users,
        as: "customer",
        attributes: ["id", "firstName", "lastName", "email", "phoneNum"],
    };

    const [totalCount, rows] = await Promise.all([
        booking.count({
            where,
            // Search predicates reference $customer.*$ → the join must exist for COUNT too.
            include: hasSearch ? [{ ...customerInclude, attributes: [] }] : undefined,
            distinct: true,
            col: "id",
        }),
        booking.findAll({
            where,
            // Keep this operational endpoint independent from unrelated booking
            // model additions. A newly deployed model must not make the payment
            // incident queue query columns that its migration has not added yet.
            attributes: [
                "id",
                "orderTrackId",
                "bookingStatusId",
                "customerId",
                "orderAmount",
                "paymentType",
                "balancePaymentMethod",
                "autoChargeStatus",
                "autoChargeDueAt",
                "lastPaymentFailureCode",
                "lastPaymentFailureMessage",
                "lastPaymentFailureAt",
                "collectionDate",
                "paymentDeliveryGate",
                "paymentAdminNotes",
                "laundryShopId",
                "zoneId",
                "createdAt",
                "updatedAt",
            ],
            include: [
                customerInclude,
                {
                    model: billingDetails,
                    as: "billingDetail",
                    required: false,
                    attributes: ["total", "paymentStatus"],
                },
                {
                    model: addressDb,
                    as: "laundryShop",
                    required: false,
                    attributes: ["id", "userId"],
                    include: [
                        {
                            model: bussinessInformation,
                            required: false,
                            attributes: ["id", "shopName"],
                        },
                    ],
                },
                {
                    model: invoicePaymentAttempt,
                    as: "invoicePaymentAttempts",
                    separate: true,
                    limit: 5,
                    order: [["id", "DESC"]],
                    attributes: [
                        "id",
                        "bookingId",
                        "attemptType",
                        "attemptNumber",
                        "status",
                        "amount",
                        "currency",
                        "stripeErrorCode",
                        "stripeDeclineCode",
                        "errorMessage",
                        "triggeredBy",
                        "createdAt",
                    ],
                },
            ],
            order: buildOrderListSequelizeOrder(options.sortBy, options.sortDir, {
                allowlist: PAYMENT_FAILURE_SORT_FIELDS,
                defaultSortBy: DEFAULT_PAYMENT_FAILURE_SORT.sortBy,
                defaultSortDir: DEFAULT_PAYMENT_FAILURE_SORT.sortDir,
            }),
            limit: window.limit,
            offset: window.offset,
        }),
    ]);

    const statusLabels = {
        9: "Services added",
        10: "Invoice generated",
        11: "Processing",
        12: "Ready for delivery",
        13: "Out for delivery",
        14: "Driver reached",
        15: "Delivery failed",
        16: "Delivered",
    };

    // Zone names for the list/CSV (booking has no zone association).
    const zoneIds = [...new Set(rows.map((r) => r.zoneId).filter((id) => id != null))];
    const zoneNameById = new Map();
    if (zoneIds.length) {
        const zones = await zone.findAll({ where: { id: zoneIds }, attributes: ["id", "name"] });
        zones.forEach((z) => zoneNameById.set(Number(z.id), z.name));
    }

    const failures = rows.map((row) => {
        const plain = row.get({ plain: true });
        const bizRows = plain.laundryShop?.bussinessInformations || plain.laundryShop?.bussinessInformation;
        const biz = Array.isArray(bizRows) ? bizRows[0] : bizRows;
        const flags = buildPaymentGateFlags(
            plain,
            plain.billingDetail?.paymentStatus === "Paid"
                ? 0
                : plain.orderAmount || 0
        );
        return {
            ...plain,
            paymentFlags: flags,
            failureReasonDisplay: formatPaymentFailureReason(
                plain.lastPaymentFailureCode,
                plain.lastPaymentFailureMessage
            ),
            bookingStatusLabel:
                statusLabels[plain.bookingStatusId] ||
                `Status ${plain.bookingStatusId}`,
            shopName: biz?.shopName || null,
            zoneName: plain.zoneId != null ? zoneNameById.get(Number(plain.zoneId)) || null : null,
        };
    });

    return {
        failures,
        totalCount,
        count: totalCount,
        pagination: buildPagination(totalCount, window),
        filters: {
            search: searchTerm,
            zoneId: zoneId ?? null,
            startDate: options.startDate || null,
            endDate: options.endDate || null,
        },
    };
}

async function resolvePaymentFailure(bookingId, action, adminUserId, notes = null) {
    const allowed = new Set(["shift_to_cash", "allow_proceed", "keep_waiting"]);
    if (!allowed.has(action)) {
        const err = new Error(
            "action must be shift_to_cash | allow_proceed | keep_waiting"
        );
        err.statusCode = 400;
        throw err;
    }

    const bookingRow = await booking.findByPk(bookingId);
    if (!bookingRow) {
        const err = new Error("Booking not found");
        err.statusCode = 404;
        throw err;
    }

    const noteText = notes ? String(notes).slice(0, 500) : null;

    if (action === "keep_waiting") {
        await bookingRow.update({
            paymentDeliveryGate: "waiting_admin",
            paymentAdminNotes: noteText,
            paymentAdminResolvedAt: new Date(),
            paymentAdminResolvedBy: adminUserId,
        });
        return { bookingId, action, paymentDeliveryGate: "waiting_admin" };
    }

    if (action === "shift_to_cash") {
        await bookingRow.update({
            balancePaymentMethod: "cash",
            paymentDeliveryGate: "cleared_cash",
            autoChargeStatus:
                bookingRow.autoChargeStatus === "succeeded"
                    ? "succeeded"
                    : "cancelled",
            autoChargeDueAt: null,
            paymentAdminNotes: noteText,
            paymentAdminResolvedAt: new Date(),
            paymentAdminResolvedBy: adminUserId,
        });
        await notifyPaymentCleared(bookingRow, action);
        return { bookingId, action, paymentDeliveryGate: "cleared_cash" };
    }

    // allow_proceed
    await bookingRow.update({
        paymentDeliveryGate: "cleared_allow",
        autoChargeStatus:
            bookingRow.autoChargeStatus === "succeeded"
                ? "succeeded"
                : "cancelled",
        autoChargeDueAt: null,
        paymentAdminNotes: noteText,
        paymentAdminResolvedAt: new Date(),
        paymentAdminResolvedBy: adminUserId,
    });
    await notifyPaymentCleared(bookingRow, action);
    return { bookingId, action, paymentDeliveryGate: "cleared_allow" };
}

function cancelAutoChargeForBooking(bookingId, reason = "cancelled") {
    return booking.update(
        {
            autoChargeStatus: "cancelled",
            autoChargeDueAt: null,
            paymentAdminNotes: reason,
        },
        { where: { id: bookingId, autoChargeStatus: { [Op.in]: ["scheduled", "failed", "processing"] } } }
    );
}

async function startInvoiceAutoChargeJob() {
    if (autoChargeTimer) return;

    const cfg = await getAutoChargeConfig();
    const intervalMs = cfg.intervalMs || ENV_AUTO_CHARGE_JOB_INTERVAL_MS;

    const run = () => {
        processDueInvoiceAutoCharges().catch((err) => {
            console.error("[invoiceAutoCharge] job error:", err.message);
        });
    };

    run();
    autoChargeTimer = setInterval(run, intervalMs);
    console.log(
        `[invoiceAutoCharge] scheduled every ${intervalMs / 1000}s (delay ${cfg.delayMs / 60000}m, enabled=${cfg.enabled})`
    );
}

async function restartInvoiceAutoChargeJob() {
    if (autoChargeTimer) {
        clearInterval(autoChargeTimer);
        autoChargeTimer = null;
    }
    await startInvoiceAutoChargeJob();
}

module.exports = {
    AUTO_CHARGE_DELAY_MS: ENV_AUTO_CHARGE_DELAY_MS,
    getAutoChargeConfig,
    scheduleInvoiceAutoCharge,
    attemptInvoiceCardCharge,
    processDueInvoiceAutoCharges,
    assertCanOutForDelivery,
    listPaymentFailures,
    resolvePaymentFailure,
    cancelAutoChargeForBooking,
    buildPaymentGateFlags,
    startInvoiceAutoChargeJob,
    restartInvoiceAutoChargeJob,
    isCardBalanceDue,
    isBookingPaid,
    resolvePickupPaymentIntentId,
};

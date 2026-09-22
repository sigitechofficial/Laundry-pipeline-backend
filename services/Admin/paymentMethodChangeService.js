'use strict';

/**
 * Admin action: change HOW an order's outstanding balance is collected
 * (card <-> cash), with a reason and full audit trail.
 *
 * Design note — why this only touches `balancePaymentMethod`, never
 * `paymentType`:
 *   The agent commission base depends on `paymentType`
 *   (cash => max(laundry, zoneMinimum), card => laundry), and the wallet
 *   ledger rows (booking_commission credit, cash_collected debit) are written
 *   once and are idempotent. Flipping `paymentType` after those rows exist
 *   silently re-prices earnings and corrupts cash-due with no self-healing.
 *   `balancePaymentMethod` is the safe, first-class lever the agent app and
 *   the payment-failure "shift to cash" flow already use: it drives
 *   amountDueNow, the OFD gate, and the cash/card channel classifier WITHOUT
 *   changing the commission base. So a conversion here never re-prices a
 *   settled order — it only changes how the remaining balance is taken.
 */

const {
    booking,
    billingDetails,
    addressDb,
    bookingPaymentMethodEvent,
} = require('../../models');
const {
    ValidationError,
    NotFoundError,
    ConflictError,
} = require('../../middlewares/universalErrorHandler');
const { CANCELLED } = require('../../constants/bookingStatusIds');
const invoiceManagementService = require('../../services/Agent/invoiceManagementService');
const invoiceAutoChargeService = require('../../services/Agent/invoiceAutoChargeService');
const { sendNotification } = require('../../utils/notification');
const { sendEvent } = require('../../socket_io');

function normalizeMethod(value) {
    const v = String(value || '').toLowerCase().trim();
    return v === 'cash' ? 'cash' : v === 'card' ? 'card' : null;
}

/** Effective current balance method (falls back to booking payment type). */
function currentBalanceMethod(bookingRow) {
    const explicit = normalizeMethod(bookingRow.balancePaymentMethod);
    if (explicit) return explicit;
    return String(bookingRow.paymentType || 'card').toLowerCase() === 'cash'
        ? 'cash'
        : 'card';
}

async function resolveAgentUserId(bookingRow) {
    if (bookingRow.driverId) return bookingRow.driverId;
    if (!bookingRow.laundryShopId) return null;
    const shop = await addressDb.findByPk(bookingRow.laundryShopId, {
        attributes: ['id', 'userId'],
    });
    return shop?.userId || null;
}

/**
 * @param {number|string} bookingId
 * @param {object} opts
 * @param {'card'|'cash'} opts.method    target balance collection method
 * @param {string} [opts.reasonCode]     stable reason code
 * @param {string} [opts.reason]         human-readable reason label
 * @param {string} [opts.note]           optional free-text note
 * @param {number} [opts.adminUserId]    acting admin (req.user.id)
 */
async function changeBalancePaymentMethod(bookingId, opts = {}) {
    const method = normalizeMethod(opts.method);
    if (!method) {
        throw new ValidationError("method must be 'card' or 'cash'");
    }
    const reasonText = opts.reason ? String(opts.reason).trim().slice(0, 255) : '';
    const reasonCode = opts.reasonCode
        ? String(opts.reasonCode).trim().slice(0, 64)
        : '';
    if (!reasonText && !reasonCode) {
        throw new ValidationError('A reason is required to change the payment method');
    }
    const note = opts.note && String(opts.note).trim() ? String(opts.note).trim() : null;

    const bookingRow = await booking.findByPk(bookingId, {
        include: [
            {
                model: billingDetails,
                as: 'billingDetail',
                required: false,
                attributes: ['paymentStatus'],
            },
        ],
    });
    if (!bookingRow) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }
    if (Number(bookingRow.bookingStatusId) === CANCELLED) {
        throw new ConflictError('This order is cancelled — payment method cannot be changed');
    }

    const bookedType = String(bookingRow.paymentType || 'card').toLowerCase();
    // A pure cash booking has no saved card / Stripe customer, so it can never
    // be charged by card. This mirrors the agent-app guard.
    if (bookedType === 'cash' && method === 'card') {
        throw new ValidationError(
            'This order was booked as cash — it cannot be switched to card (no card on file). Take payment in cash.'
        );
    }

    const fromMethod = currentBalanceMethod(bookingRow);

    const summaryBefore =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const amountDueNow = Number(summaryBefore?.amountDueNow ?? 0);
    const billingPaid = bookingRow.billingDetail?.paymentStatus === 'Paid';

    // Nothing left to collect -> no method to change.
    if (amountDueNow <= 0.02 && billingPaid) {
        throw new ValidationError(
            'No balance is due — there is nothing left to collect, so the method cannot be changed'
        );
    }

    // Card balance already captured -> switching to cash would double-collect.
    // The correct tool for money already taken by card is Issue Refund.
    if (
        method === 'cash' &&
        String(bookingRow.balanceCollectedVia || '').toLowerCase() === 'card'
    ) {
        throw new ConflictError(
            'The balance was already collected by card. Issue a refund first, then switch to cash.'
        );
    }

    // No-op: already on the requested method.
    if (fromMethod === method) {
        return {
            bookingId: Number(bookingId),
            changed: false,
            fromMethod,
            toMethod: method,
            amountDueNow,
            paymentSummary: summaryBefore,
            message: `Balance is already set to be collected by ${method}`,
        };
    }

    // ---- Apply the switch (same side-effects as the agent-app lever) ----
    const updatePayload = {
        balancePaymentMethod: method,
        // Reuse the existing single-slot admin-resolution stamp so the last
        // admin touch on payment is always visible on the booking.
        paymentAdminNotes: note || reasonText || reasonCode || null,
        paymentAdminResolvedAt: new Date(),
        paymentAdminResolvedBy: opts.adminUserId || null,
    };
    if (method === 'cash') {
        updatePayload.autoChargeStatus =
            bookingRow.autoChargeStatus === 'succeeded' ? 'succeeded' : 'cancelled';
        updatePayload.autoChargeDueAt = null;
        updatePayload.paymentDeliveryGate = 'cleared_cash';
    } else {
        updatePayload.paymentDeliveryGate = 'open';
    }
    await bookingRow.update(updatePayload);

    if (method === 'card') {
        // Re-arm the 2h auto-charge so the balance is taken by card again.
        await invoiceAutoChargeService
            .scheduleInvoiceAutoCharge(bookingId, { forceReschedule: true })
            .catch((e) =>
                console.error(
                    `[paymentMethodChange] reschedule failed for ${bookingId}:`,
                    e?.message || e
                )
            );
    }

    // ---- Audit row ----
    let auditRow = null;
    try {
        auditRow = await bookingPaymentMethodEvent.create({
            bookingId: Number(bookingId),
            field: 'balancePaymentMethod',
            fromMethod,
            toMethod: method,
            actedByUserId: opts.adminUserId || null,
            actorType: 'admin',
            reasonCode: reasonCode || null,
            reasonText: reasonText || null,
            note,
            amountDueSnapshot: Number.isFinite(amountDueNow) ? amountDueNow : null,
        });
    } catch (e) {
        // Never fail the money-affecting switch because the audit insert failed.
        console.error(
            `[paymentMethodChange] audit insert failed for ${bookingId}:`,
            e?.message || e
        );
    }

    // ---- Refresh summary + gate flags (for the response and the agent app) ----
    const summaryAfter =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const refreshed = await booking.findByPk(bookingId);
    const gateFlags = invoiceAutoChargeService.buildPaymentGateFlags(
        refreshed,
        summaryAfter?.amountDueNow ?? 0
    );

    // ---- Notify the agent (FCM + socket) so their app shows the new state ----
    try {
        const agentUserId = await resolveAgentUserId(refreshed);
        if (agentUserId) {
            const orderRef = refreshed.orderTrackId || refreshed.id;
            const symbol = summaryAfter?.currencySymbol || '£';
            const due = Number(summaryAfter?.amountDueNow ?? 0).toFixed(2);
            const body =
                method === 'cash'
                    ? `Order ${orderRef}: switched to CASH by admin. Collect ${symbol}${due} in cash at delivery.`
                    : `Order ${orderRef}: switched to CARD by admin. The balance will be charged to the customer's card.`;
            const payload = {
                bookingId: String(refreshed.id),
                type: 'PAYMENT_METHOD_CHANGED',
                method,
                fromMethod,
                amountDueNow: due,
                reason: reasonText || reasonCode || '',
            };
            sendNotification(agentUserId, 'Payment method changed', body, payload).catch(
                (e) =>
                    console.error(
                        '[paymentMethodChange] FCM notify failed:',
                        e?.message || e
                    )
            );
            sendEvent(agentUserId, {
                type: 'paymentMethodChanged',
                data: payload,
            }).catch((e) =>
                console.error(
                    '[paymentMethodChange] socket notify failed:',
                    e?.message || e
                )
            );
        }
    } catch (e) {
        console.error('[paymentMethodChange] notify block failed:', e?.message || e);
    }

    return {
        bookingId: Number(bookingId),
        changed: true,
        fromMethod,
        toMethod: method,
        amountDueNow: Number(summaryAfter?.amountDueNow ?? 0),
        eventId: auditRow?.id || null,
        paymentSummary: { ...summaryAfter, ...gateFlags },
        ...gateFlags,
    };
}

module.exports = { changeBalancePaymentMethod };

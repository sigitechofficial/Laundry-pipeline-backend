const {
    booking,
    cancelBooking,
    users,
    policy,
    cancellationPolicyConfig,
    bookingHistory,
    wallet,
    billingDetails,
    tip,
} = require('../../models');
const { Op } = require('sequelize');
const moment = require('moment-timezone');
const {
    chargeOffSession,
    refundPaymentIntent,
    cancelPaymentIntent,
    getIntent,
    updatePaymentIntentPresentation,
} = require('../../controllers/stripe');
const {
    buildStripeChargePresentation,
    buildStripeRefundPresentation,
} = require('../../utils/stripePaymentMetadata');
const { getPickupChargeAmount } = require('../../utils/invoicePrepaidDeduction');
const activePoliciesService = require('../Admin/activePoliciesService');

const BUSINESS_TIME_ZONE = 'Europe/London';
const { 
    ValidationError, 
    NotFoundError, 
    ConflictError 
} = require('../../middlewares/universalErrorHandler');

/**
 * Customer Booking Cancellation Service
 * Handles booking cancellations with cancellation policy enforcement
 */
class CancelBookingService {
    _getStoredDatePart(dateValue, fieldName) {
        if (typeof dateValue === 'string' && dateValue.length >= 10) {
            return dateValue.slice(0, 10);
        }

        if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
            const year = dateValue.getFullYear();
            const month = String(dateValue.getMonth() + 1).padStart(2, '0');
            const day = String(dateValue.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        throw new ValidationError(`${fieldName} must be a valid date`);
    }

    /**
     * Prepaid amount captured at pickup (upfront + service fee + tip).
     */
    resolvePrepaidChargedAmount(bookingData) {
        const billing = bookingData.billingDetail || {};
        const tips = Array.isArray(bookingData.tips) ? bookingData.tips : [];
        const tipTotal = tips.reduce(
            (sum, t) => sum + (parseFloat(t.amount) || 0),
            0
        );
        const fromBilling = getPickupChargeAmount(
            billing.upfrontAmount,
            billing.serviceCharge,
            tipTotal
        );
        if (fromBilling > 0) {
            return fromBilling;
        }
        const orderAmount = parseFloat(bookingData.orderAmount) || 0;
        return orderAmount > 0 ? orderAmount : 0;
    }

    /**
     * Off-session cancel fee to charge on the saved card.
     * Hold-only: full policy fee. Captured + fee > prepaid: remaining (fee − prepaid).
     */
    resolveSeparateCancelChargeAmount(
        cancellationCharge,
        prepaidAlreadyCaptured,
        prepaidCharged
    ) {
        const fee = parseFloat(cancellationCharge) || 0;
        const prepaid = parseFloat(prepaidCharged) || 0;
        if (fee <= 0) {
            return 0;
        }
        if (!prepaidAlreadyCaptured) {
            return parseFloat(fee.toFixed(2));
        }
        if (prepaid > 0 && fee > prepaid) {
            return parseFloat((fee - prepaid).toFixed(2));
        }
        return 0;
    }

    /**
     * Charge cancellation fee (full or remaining) via Stripe off-session.
     */
    async attemptCancellationFeeCharge(
        customerId,
        bookingData,
        chargeAmount,
        currency,
        totalCancellationFee,
        extraPresentation = {}
    ) {
        if (!chargeAmount || chargeAmount <= 0) {
            return { stripeChargeResult: null, stripeChargeError: null };
        }

        const savedPaymentMethodId = bookingData.paymentMethodId;
        if (!savedPaymentMethodId) {
            return {
                stripeChargeResult: null,
                stripeChargeError: 'No saved payment method found for this booking',
            };
        }

        const customerData = await users.findOne({
            where: { id: customerId },
            attributes: [
                'id',
                'firstName',
                'lastName',
                'email',
                'stripeCustomerId',
            ],
        });

        if (!customerData?.stripeCustomerId) {
            return {
                stripeChargeResult: null,
                stripeChargeError: 'No Stripe customer ID found for this customer',
            };
        }

        try {
            const idempotencyKey = `cancel-booking-${bookingData.id}-customer-${customerId}-fee`;
            const stripePresentation = buildStripeChargePresentation({
                chargeType: 'cancellation_fee',
                bookingId: bookingData.id,
                orderTrackId: bookingData.orderTrackId,
                amount: chargeAmount,
                currency: currency || 'GBP',
                paymentType: bookingData.paymentType || 'card',
                customer: customerData,
                agent: {},
                zoneId: bookingData.zoneId,
                laundryShopId: bookingData.laundryShopId,
                extra: {
                    totalCancellationFee: String(totalCancellationFee),
                    ...extraPresentation,
                },
            });
            const stripeChargeResult = await chargeOffSession(
                chargeAmount,
                customerData.stripeCustomerId,
                savedPaymentMethodId,
                idempotencyKey,
                stripePresentation
            );
            console.log(
                `✅ Cancellation charge of ${chargeAmount} ${currency} charged to customer ${customerId} for booking ${bookingData.id}`
            );
            return { stripeChargeResult, stripeChargeError: null };
        } catch (chargeErr) {
            console.error(
                `❌ Failed to charge cancellation fee for booking ${bookingData.id}:`,
                chargeErr.message
            );
            return { stripeChargeResult: null, stripeChargeError: chargeErr.message };
        }
    }

    /**
     * Cancel a booking with policy-based charge calculation
     * @param {number} bookingId - Booking ID to cancel
     * @param {number} customerId - Customer ID requesting cancellation
     * @param {number} reasonId - Optional reason ID
     * @param {string} reasonText - Cancellation reason text
     * @param {string} timeZone - IANA timezone of the caller (e.g. "Asia/Karachi"). Falls back to business timezone.
     * @returns {Object} Cancellation result with charges
     */
    async cancelCustomerBooking(bookingId, customerId, reasonId = null, reasonText, timeZone = null) {
        // Step 1: Fetch booking details
        const bookingData = await booking.findOne({
            where: {
                id: bookingId,
                customerId: customerId
            },
            attributes: [
                'id', 
                'customerId', 
                'bookingStatusId', 
                'zoneId',
                'cancellationPolicyId',
                'collectionDate', 
                'collectionTimeFrom',
                'orderAmount',
                'paymentConfirmed',
                'paymentMethodId',
                'paymentIntentId',
                'orderTrackId',
                'paymentType',
                'laundryShopId',
                'createdAt'
            ],
            include: [
                {
                    model: billingDetails,
                    as: 'billingDetail',
                    required: false,
                    attributes: ['upfrontAmount', 'serviceCharge', 'total', 'paymentStatus'],
                },
                {
                    model: tip,
                    as: 'tips',
                    required: false,
                    attributes: ['id', 'amount'],
                },
            ],
        });

        if (!bookingData) {
            throw new NotFoundError("Booking not found or you don't have permission to cancel this booking");
        }

        // Step 2: Check if booking is in Processing (Status 11)
        if (bookingData.bookingStatusId === 11) {
            throw new ValidationError("Cannot cancel booking. Items are currently being processed at the facility");
        }

        // Step 3: Check if booking is already cancelled
        if (bookingData.bookingStatusId === 19) {
            throw new ConflictError("This booking has already been cancelled");
        }

        // Step 4: Check if booking is completed
        if ([16, 17].includes(bookingData.bookingStatusId)) {
            throw new ValidationError("Cannot cancel completed bookings");
        }

        // Step 4b: No customer cancel once invoice is generated (status 10+) or later workflow stages
        if (bookingData.bookingStatusId >= 10) {
            if (bookingData.bookingStatusId === 10) {
                throw new ValidationError(
                    "Cannot cancel booking. Invoice has already been generated"
                );
            }
            throw new ValidationError("Cannot cancel booking at this stage");
        }

        // Step 5: Use snapshotted policy when present, otherwise zone/global active policy
        const activeCancellationPolicy = await this.resolveCancellationPolicy(bookingData);

        // Fee % base = prepaid bill (upfront + service fee + tip), even before capture.
        // Refund base = only amount actually captured (paymentConfirmed).
        const feeBaseAmount = this.resolvePrepaidChargedAmount(bookingData);
        const prepaidCharged = bookingData.paymentConfirmed ? feeBaseAmount : 0;
        const cancellationDetails = await this.calculateCancellationCharge(
            bookingData,
            activeCancellationPolicy,
            customerId,
            timeZone,
            prepaidCharged,
            feeBaseAmount
        );

        // Step 7a: Release uncaptured authorization hold (placed at booking)
        // before any separate cancel-fee charge. Captured payments use refund instead.
        let authHoldRelease = null;
        let authHoldReleaseError = null;
        if (
            bookingData.paymentIntentId &&
            !bookingData.paymentConfirmed &&
            (bookingData.paymentType || 'card') !== 'cash'
        ) {
            try {
                const intent = await getIntent(bookingData.paymentIntentId);
                if (intent?.status === 'requires_capture') {
                    authHoldRelease = await cancelPaymentIntent(
                        bookingData.paymentIntentId,
                        {
                            cancellation_reason: 'requested_by_customer',
                            idempotencyKey: `cancel-release-hold-${bookingId}`,
                        }
                    );
                    console.log(
                        `✅ Released auth hold ${bookingData.paymentIntentId} for cancelled booking ${bookingId}`
                    );
                } else if (intent?.status === 'canceled') {
                    authHoldRelease = {
                        id: bookingData.paymentIntentId,
                        status: 'canceled',
                        alreadyCanceled: true,
                    };
                } else if (intent?.status === 'succeeded') {
                    // Unexpected for paymentConfirmed=false — leave for refund path if flags catch up
                    console.warn(
                        `⚠️ Booking ${bookingId} has succeeded PI but paymentConfirmed=false`
                    );
                }
            } catch (holdErr) {
                authHoldReleaseError = holdErr.message;
                console.error(
                    `❌ Failed to release auth hold for booking ${bookingId}:`,
                    holdErr.message
                );
            }
        }

        // Step 7b: Off-session cancel fee — full fee (hold-only) or remaining (captured + fee > prepaid).
        const prepaidAlreadyCaptured =
            Boolean(bookingData.paymentConfirmed) &&
            Boolean(bookingData.paymentIntentId);
        const separateCancelChargeAmount = this.resolveSeparateCancelChargeAmount(
            cancellationDetails.cancellationCharge,
            prepaidAlreadyCaptured,
            prepaidCharged
        );
        const prepaidRetainedAsFee =
            prepaidAlreadyCaptured && cancellationDetails.cancellationCharge > 0
                ? parseFloat(
                      Math.min(
                          prepaidCharged,
                          cancellationDetails.cancellationCharge
                      ).toFixed(2)
                  )
                : 0;

        let stripeChargeResult = null;
        let stripeChargeError = null;
        const isCardPayment = (bookingData.paymentType || 'card') !== 'cash';

        if (separateCancelChargeAmount > 0 && isCardPayment) {
            const chargeOutcome = await this.attemptCancellationFeeCharge(
                customerId,
                bookingData,
                separateCancelChargeAmount,
                cancellationDetails.currency,
                cancellationDetails.cancellationCharge,
                prepaidRetainedAsFee > 0
                    ? {
                          prepaidRetainedAsFee: String(prepaidRetainedAsFee),
                          feeComponent: 'remaining_after_prepaid_retained',
                      }
                    : {}
            );
            stripeChargeResult = chargeOutcome.stripeChargeResult;
            stripeChargeError = chargeOutcome.stripeChargeError;
        }

        // Step 8: Create cancellation record
        await cancelBooking.create({
            bookingId: bookingId,
            reasonId: reasonId,
            reasonText: reasonText,
            userId: customerId
        });

        // Step 9: Cancel booking; attach cancellation policy only when a real policy exists
        const cancelPayload = { bookingStatusId: 19 };
        if (activeCancellationPolicy?.id) {
            cancelPayload.cancellationPolicyId = activeCancellationPolicy.id;
        }
        await booking.update(cancelPayload, { where: { id: bookingId } });

        // Close any active live-tracking session (non-blocking)
        try {
            const { syncLiveTrackingForBookingStatus } = require('../../utils/liveTrackingRtdb');
            syncLiveTrackingForBookingStatus(bookingId, 19, { reason: 'cancelled' }).catch(() => {});
        } catch (_) { /* ignore */ }

        // Step 10: Create booking history entry using caller/business timezone wall-clock
        const resolvedTz = this._resolveTimeZone(timeZone);
        const cancellationMoment = moment.tz(resolvedTz);
        await bookingHistory.create({
            bookingId: bookingId,
            bookingStatusId: 19,
            date: cancellationMoment.format('YYYY-MM-DD'),
            time: cancellationMoment.format('HH:mm:ss')
        });

        // Step 11: Stripe refund of prepaid (when card was charged at pickup) + wallet ledger
        let refundDetails = null;
        let stripeRefundError = null;
        let stripeDescriptionError = null;

        if (
            bookingData.paymentConfirmed &&
            bookingData.paymentIntentId &&
            cancellationDetails.refundAmount > 0 &&
            (bookingData.paymentType || 'card') !== 'cash'
        ) {
            try {
                const customerForStripe = await users.findOne({
                    where: { id: customerId },
                    attributes: ['id', 'firstName', 'lastName', 'email', 'stripeCustomerId'],
                });
                const refundPresentation = buildStripeRefundPresentation({
                    bookingId,
                    orderTrackId: bookingData.orderTrackId,
                    amountRefunded: cancellationDetails.refundAmount,
                    feeRetained: cancellationDetails.cancellationCharge,
                    currency: cancellationDetails.currency,
                    customer: customerForStripe || { id: customerId },
                });
                refundDetails = await this.processRefund(
                    customerId,
                    bookingId,
                    cancellationDetails.refundAmount,
                    cancellationDetails.currency,
                    bookingData.paymentIntentId,
                    bookingData.orderTrackId,
                    refundPresentation
                );
            } catch (refundErr) {
                stripeRefundError = refundErr.message;
                console.error(
                    `❌ Failed to refund booking ${bookingId}:`,
                    refundErr.message
                );
            }
        } else if (
            bookingData.paymentConfirmed &&
            bookingData.paymentIntentId &&
            cancellationDetails.refundAmount <= 0 &&
            cancellationDetails.cancellationCharge > 0 &&
            (bookingData.paymentType || 'card') !== 'cash'
        ) {
            try {
                const customerForStripe = await users.findOne({
                    where: { id: customerId },
                    attributes: ['id', 'firstName', 'lastName', 'email', 'stripeCustomerId'],
                });
                const retainedPresentation = buildStripeRefundPresentation({
                    bookingId,
                    orderTrackId: bookingData.orderTrackId,
                    amountRefunded: 0,
                    feeRetained: cancellationDetails.cancellationCharge,
                    currency: cancellationDetails.currency,
                    customer: customerForStripe || { id: customerId },
                });
                await updatePaymentIntentPresentation(
                    bookingData.paymentIntentId,
                    retainedPresentation,
                    { mergeMetadata: true }
                );
            } catch (descErr) {
                stripeDescriptionError = descErr.message;
                console.warn(
                    `⚠️ Failed to update Stripe description for booking ${bookingId}:`,
                    descErr.message
                );
            }
        } else if (
            bookingData.paymentConfirmed &&
            cancellationDetails.refundAmount > 0 &&
            !bookingData.paymentIntentId
        ) {
            // No PaymentIntent — keep wallet credit ledger only
            try {
                refundDetails = await this.processWalletRefundOnly(
                    customerId,
                    bookingId,
                    cancellationDetails.refundAmount,
                    cancellationDetails.currency
                );
            } catch (walletErr) {
                stripeRefundError = walletErr.message;
                console.error(
                    `❌ Failed wallet refund ledger for booking ${bookingId}:`,
                    walletErr.message
                );
            }
        }

        return {
            bookingId: bookingId,
            status: 'cancelled',
            cancellationCharge: cancellationDetails.cancellationCharge,
            currency: cancellationDetails.currency,
            refundAmount: cancellationDetails.refundAmount,
            feeBaseAmount: cancellationDetails.feeBaseAmount,
            prepaidCharged: prepaidCharged,
            totalPaid: prepaidCharged || 0,
            policyApplied: cancellationDetails.policyApplied,
            cancellationReason: cancellationDetails.reason,
            refundProcessed: refundDetails !== null,
            refundDetails: refundDetails,
            cancellationFeeCharged: stripeChargeResult !== null,
            separateCancelFeeAmount: separateCancelChargeAmount,
            prepaidRetainedAsFee,
            stripeChargeId: stripeChargeResult?.id || null,
            stripeChargeStatus: stripeChargeResult?.status || null,
            stripeChargeError: stripeChargeError,
            stripeRefundError: stripeRefundError,
            stripeDescriptionError: stripeDescriptionError,
            authHoldReleased: Boolean(
                authHoldRelease &&
                    (authHoldRelease.status === 'canceled' ||
                        authHoldRelease.alreadyCanceled)
            ),
            authHoldReleaseError: authHoldReleaseError,
            message: cancellationDetails.message
        };
    }

    /**
     * Resolve cancellation policy for a booking.
     * Prefers the policy snapshotted on the booking, then zone/global active policy,
     * then a built-in free-cancellation fallback for charge calculation.
     * @param {Object} bookingData
     * @returns {Object} Cancellation policy with config (may lack id on fallback)
     */
    async resolveCancellationPolicy(bookingData) {
        if (bookingData.cancellationPolicyId) {
            const snapshotted = await policy.findOne({
                where: { id: bookingData.cancellationPolicyId },
                include: [
                    {
                        model: cancellationPolicyConfig,
                        as: 'cancellationConfig',
                        required: false,
                    },
                ],
            });
            if (snapshotted) return snapshotted;
        }

        const activePolicy = await activePoliciesService.getActiveCancellationPolicy(
            bookingData.zoneId
        );
        if (activePolicy) return activePolicy;

        return {
            cancellationConfig: {
                prePickupFreeChargeWindowMinutes: 120,
                prePickupFirstCancellationLeniency: true,
                prePickupAbsoluteAmount: 0,
                prePickupPercentage: 0,
                unprocessedAbsoluteAmount: 0,
                unprocessedPercentage: 0,
                unprocessedAfterPickupMinutes: 30,
                unprocessedOrderValuePercentage: 0,
                allowCancelUnprocessed: true,
                courtesyWindowDays: 30,
                courtesyCapAmount: 0,
                courtesyCount: 1,
                customerLeniencyEnabled: false,
                prePickupAbsoluteCurrency: 'USD',
                unprocessedAbsoluteCurrency: 'USD',
            },
        };
    }

    /**
     * Calculate cancellation charge based on policy and booking status
     * @param {Object} bookingData - Booking data
     * @param {Object} cancellationPolicy - Cancellation policy
     * @param {number} customerId - Customer ID
     * @param {string} timeZone - IANA timezone for time comparison
     * @param {number} [prepaidCharged] - Amount already captured (refund base)
     * @param {number} [feeBaseAmount] - Prepaid bill for % fees: upfront + service fee + tip
     * @returns {Object} Cancellation charge details
     */
    async calculateCancellationCharge(
        bookingData,
        cancellationPolicy,
        customerId,
        timeZone = null,
        prepaidCharged = 0,
        feeBaseAmount = 0
    ) {
        const config = cancellationPolicy.cancellationConfig;
        const bookingStatusId = bookingData.bookingStatusId;
        let cancellationCharge = 0;
        let policyApplied = 'No Charge';
        let reason = '';
        let currency = config.prePickupAbsoluteCurrency || 'USD';

        // Percentage fees use prepaid bill (upfront + service fee + tip), not laundry orderAmount.
        const percentageBase =
            feeBaseAmount > 0
                ? feeBaseAmount
                : this.resolvePrepaidChargedAmount(bookingData);

        // Pre-Pickup Phase (Status 1-3: Order Created, Confirmed, Awaiting Collection)
        if ([1, 2, 3].includes(bookingStatusId)) {
            const result = await this.calculatePrePickupCharge(
                bookingData,
                config,
                customerId,
                timeZone,
                percentageBase
            );
            cancellationCharge = result.charge;
            policyApplied = result.policyApplied;
            reason = result.reason;
            currency = config.prePickupAbsoluteCurrency;
        }
        // Unprocessed Phase (Status 4-9: through agent services added; before invoice)
        else if ([4, 5, 6, 7, 8, 9].includes(bookingStatusId)) {
            if (!config.allowCancelUnprocessed) {
                throw new ValidationError("Cancellation is not allowed at this stage according to the policy");
            }

            const result = await this.calculateUnprocessedCharge(
                bookingData,
                config,
                customerId,
                percentageBase
            );
            cancellationCharge = result.charge;
            policyApplied = result.policyApplied;
            reason = result.reason;
            currency = config.unprocessedAbsoluteCurrency;
        }
        // Other statuses (12-18: Out for delivery, delivered, on hold, etc.)
        else {
            cancellationCharge = 0;
            policyApplied = 'Free Cancellation';
            reason = 'Booking status allows free cancellation';
        }

        // Apply customer leniency
        if (config.customerLeniencyEnabled && cancellationCharge > 0) {
            const leniencyResult = await this.applyCustomerLeniency(
                customerId,
                cancellationCharge,
                config
            );
            
            if (leniencyResult.applied) {
                cancellationCharge = leniencyResult.adjustedCharge;
                policyApplied = leniencyResult.policyApplied;
                reason = leniencyResult.reason;
            }
        }

        // Refund = captured prepaid minus cancellation fee (uncaptured hold ⇒ prepaidCharged 0)
        const totalPaid =
            prepaidCharged > 0
                ? prepaidCharged
                : 0;
        const refundAmount = Math.max(0, totalPaid - cancellationCharge);

        return {
            cancellationCharge: parseFloat(cancellationCharge.toFixed(2)),
            refundAmount: parseFloat(refundAmount.toFixed(2)),
            feeBaseAmount: parseFloat((percentageBase || 0).toFixed(2)),
            currency: currency,
            policyApplied: policyApplied,
            reason: reason,
            message: cancellationCharge > 0 
                ? `A cancellation charge of ${currency} ${cancellationCharge.toFixed(2)} will be applied` 
                : 'No cancellation charges applied'
        };
    }

    /**
     * Resolve a valid IANA timezone string, falling back to the business timezone.
     */
    _resolveTimeZone(timeZone) {
        if (timeZone && typeof timeZone === 'string' && moment.tz.zone(timeZone.trim())) {
            return timeZone.trim();
        }
        return BUSINESS_TIME_ZONE;
    }

    /**
     * Calculate pre-pickup cancellation charge
     * @param {Object} bookingData - Booking data
     * @param {Object} config - Policy config
     * @param {number} customerId - Customer ID
     * @param {string} timeZone - IANA timezone from the frontend (e.g. "Asia/Karachi")
     * @param {number} [percentageBase] - Prepaid bill (upfront + service fee + tip) for % fees
     * @returns {Object} Charge details
     */
    async calculatePrePickupCharge(
        bookingData,
        config,
        customerId,
        timeZone = null,
        percentageBase = 0
    ) {
        // Use the timezone sent by the frontend; fall back to business timezone if not provided.
        const tz = this._resolveTimeZone(timeZone);

        // Both pickup time and now are interpreted in the same timezone so the diff is always accurate.
        const collectionDatePart = this._getStoredDatePart(bookingData.collectionDate, 'collectionDate');
        const collectionDateTime = moment.tz(
            `${collectionDatePart} ${bookingData.collectionTimeFrom}`,
            'YYYY-MM-DD HH:mm:ss',
            tz
        );

        const now = moment.tz(tz);
        const minutesUntilPickup = collectionDateTime.diff(now, 'minutes');

        // A 0-minute free window means no free pre-pickup cancellations.
        const freeWindowMinutes = Number(config.prePickupFreeChargeWindowMinutes) || 0;
        if (freeWindowMinutes > 0 && minutesUntilPickup > freeWindowMinutes) {
            return {
                charge: 0,
                policyApplied: 'Free Cancellation Window',
                reason: `Cancelled ${minutesUntilPickup} minutes before pickup (free window: ${freeWindowMinutes} minutes)`
            };
        }

        // Check first cancellation leniency
        if (config.prePickupFirstCancellationLeniency) {
            const isFirstCancellation = await this.isFirstCancellation(customerId);
            if (isFirstCancellation) {
                return {
                    charge: 0,
                    policyApplied: 'First Cancellation Leniency',
                    reason: 'No charge applied for first cancellation'
                };
            }
        }

        // Calculate charge — % of prepaid bill (upfront + service fee + tip), not laundry orderAmount
        let charge = 0;
        if (config.prePickupAbsoluteAmount) {
            charge = parseFloat(config.prePickupAbsoluteAmount);
        }

        const base = parseFloat(percentageBase) || 0;
        if (config.prePickupPercentage && base > 0) {
            const percentageCharge =
                (base * parseFloat(config.prePickupPercentage)) / 100;
            charge = Math.max(charge, percentageCharge);
        }

        return {
            charge: charge,
            policyApplied: 'Pre-Pickup Cancellation Charge',
            reason: `Cancelled ${minutesUntilPickup} minutes before pickup (outside free window)`
        };
    }

    /**
     * Calculate unprocessed cancellation charge
     * @param {Object} bookingData - Booking data
     * @param {Object} config - Policy config
     * @param {number} customerId - Customer ID
     * @param {number} [percentageBase] - Prepaid bill (upfront + service fee + tip) for % fees
     * @returns {Object} Charge details
     */
    async calculateUnprocessedCharge(
        bookingData,
        config,
        customerId,
        percentageBase = 0
    ) {
        let charge = 0;

        // Apply absolute amount
        if (config.unprocessedAbsoluteAmount) {
            charge = parseFloat(config.unprocessedAbsoluteAmount);
        }

        // Single canonical % field: unprocessedOrderValuePercentage (% of prepaid).
        // Legacy fallback: older policies may only have unprocessedPercentage set.
        const configuredPercent =
            config.unprocessedOrderValuePercentage != null &&
            config.unprocessedOrderValuePercentage !== "" &&
            Number(config.unprocessedOrderValuePercentage) > 0
                ? parseFloat(config.unprocessedOrderValuePercentage)
                : parseFloat(config.unprocessedPercentage) || 0;

        const base = parseFloat(percentageBase) || 0;
        if (configuredPercent > 0 && base > 0) {
            const percentageCharge = (base * configuredPercent) / 100;
            charge = Math.max(charge, percentageCharge);
        }

        return {
            charge: charge,
            policyApplied: 'Unprocessed Stage Cancellation',
            reason: 'Items have been collected but not yet processed'
        };
    }

    /**
     * Apply customer leniency
     * @param {number} customerId - Customer ID
     * @param {number} currentCharge - Current calculated charge
     * @param {Object} config - Policy config
     * @returns {Object} Leniency result
     */
    async applyCustomerLeniency(customerId, currentCharge, config) {
        const windowStartDate = moment().subtract(config.courtesyWindowDays, 'days').toDate();

        // Count cancellations within the courtesy window
        const recentCancellations = await cancelBooking.count({
            include: [{
                model: booking,
                where: {
                    customerId: customerId,
                    bookingStatusId: 19,
                    createdAt: {
                        [Op.gte]: windowStartDate
                    }
                }
            }]
        });

        // Check if customer is within courtesy count
        if (recentCancellations < config.courtesyCount) {
            const adjustedCharge = Math.min(currentCharge, parseFloat(config.courtesyCapAmount));
            
            return {
                applied: true,
                adjustedCharge: adjustedCharge,
                policyApplied: 'Customer Leniency Applied',
                reason: `Courtesy cancellation ${recentCancellations + 1} of ${config.courtesyCount} (charge capped at ${config.courtesyCapAmount})`
            };
        }

        return {
            applied: false,
            adjustedCharge: currentCharge,
            policyApplied: null,
            reason: null
        };
    }

    /**
     * Check if this is customer's first cancellation
     * @param {number} customerId - Customer ID
     * @returns {boolean} True if first cancellation
     */
    async isFirstCancellation(customerId) {
        const cancellationCount = await cancelBooking.count({
            include: [{
                model: booking,
                where: {
                    customerId: customerId,
                    bookingStatusId: 19
                }
            }]
        });

        return cancellationCount === 0;
    }

    /**
     * Refund prepaid amount via Stripe PaymentIntent + wallet ledger.
     */
    async processRefund(
        customerId,
        bookingId,
        refundAmount,
        currency,
        paymentIntentId,
        orderTrackId,
        stripePresentation = null
    ) {
        const amount = parseFloat(refundAmount) || 0;
        if (amount <= 0) {
            return null;
        }

        const stripeRefund = await refundPaymentIntent(paymentIntentId, amount, {
            reason: "requested_by_customer",
            idempotencyKey: `cancel-refund-${bookingId}-${customerId}`,
            metadata: {
                bookingId: String(bookingId),
                orderTrackId: orderTrackId || String(bookingId),
                type: "cancellation_refund",
            },
            stripeOptions: stripePresentation || undefined,
        });

        if (stripeRefund?.alreadyRefunded) {
            console.log(
                `ℹ️ PaymentIntent ${paymentIntentId} already fully refunded for booking ${bookingId}`
            );
            return {
                stripeRefundId: null,
                stripeRefundStatus: "already_refunded",
                alreadyRefunded: true,
                walletTransactionId: null,
                refundAmount: 0,
                currency: currency,
                paymentIntentId,
                processedAt: moment().format("YYYY-MM-DD HH:mm:ss"),
            };
        }

        const refundedMajor =
            stripeRefund?.amount != null
                ? Number(stripeRefund.amount) / 100
                : amount;

        let walletEntry = null;
        try {
            walletEntry = await wallet.create({
                userId: customerId,
                bookingId: bookingId,
                referenceType: "customer_refund",
                amount: refundedMajor,
                type: "credit",
                description: `Stripe refund for cancelled booking #${
                    orderTrackId || bookingId
                }`,
                currency: currency || "GBP",
                status: "completed",
            });
        } catch (walletErr) {
            console.error(
                `⚠️ Wallet ledger failed after Stripe refund for booking ${bookingId}:`,
                walletErr.message
            );
        }

        console.log(
            `✅ Refunded ${refundedMajor} ${currency} for booking ${bookingId} (PI ${paymentIntentId})`
        );

        return {
            stripeRefundId: stripeRefund?.id || null,
            stripeRefundStatus: stripeRefund?.status || null,
            alreadyRefunded: false,
            walletTransactionId: walletEntry?.id || null,
            refundAmount: refundedMajor,
            currency: currency,
            paymentIntentId,
            processedAt: moment().format("YYYY-MM-DD HH:mm:ss"),
        };
    }

    /**
     * Wallet-only credit when there is no PaymentIntent to refund.
     */
    async processWalletRefundOnly(customerId, bookingId, refundAmount, currency) {
        const walletEntry = await wallet.create({
            userId: customerId,
            bookingId: bookingId,
            referenceType: "customer_refund",
            amount: refundAmount,
            type: "credit",
            description: `Refund for cancelled booking #${bookingId}`,
            currency: currency,
            status: "completed",
        });

        return {
            stripeRefundId: null,
            walletTransactionId: walletEntry.id,
            refundAmount: refundAmount,
            currency: currency,
            processedAt: moment().format("YYYY-MM-DD HH:mm:ss"),
        };
    }

    /**
     * Get customer's cancellation history
     * @param {number} customerId - Customer ID
     * @param {number} days - Number of days to look back
     * @returns {Object} Cancellation history
     */
    async getCustomerCancellationHistory(customerId, days = 30) {
        const windowStartDate = moment().subtract(days, 'days').toDate();

        const cancellations = await cancelBooking.findAll({
            include: [{
                model: booking,
                where: {
                    customerId: customerId,
                    bookingStatusId: 19,
                    createdAt: {
                        [Op.gte]: windowStartDate
                    }
                },
                attributes: ['id', 'orderTrackId', 'orderAmount', 'createdAt']
            }],
            order: [['createdAt', 'DESC']]
        });

        return {
            totalCancellations: cancellations.length,
            windowDays: days,
            cancellations: cancellations
        };
    }
}

module.exports = new CancelBookingService();


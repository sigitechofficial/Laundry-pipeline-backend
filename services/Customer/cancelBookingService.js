const { booking, cancelBooking, users, policy, cancellationPolicyConfig, bookingHistory, wallet } = require('../../models');
const { Op } = require('sequelize');
const moment = require('moment-timezone');
const { chargeOffSession } = require('../../controllers/stripe');
const { buildStripeChargePresentation } = require('../../utils/stripePaymentMetadata');
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
                'orderTrackId',
                'paymentType',
                'laundryShopId',
                'createdAt'
            ]
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

        // Step 5: Use snapshotted policy when present, otherwise zone/global active policy
        const activeCancellationPolicy = await this.resolveCancellationPolicy(bookingData);

        // Step 6: Calculate cancellation charges based on policy
        const cancellationDetails = await this.calculateCancellationCharge(
            bookingData,
            activeCancellationPolicy,
            customerId,
            timeZone
        );

        // Step 7: Charge customer via Stripe if a cancellation fee applies
        let stripeChargeResult = null;
        let stripeChargeError = null;
        if (cancellationDetails.cancellationCharge > 0) {
            const savedPaymentMethodId = bookingData.paymentMethodId;

            if (savedPaymentMethodId) {
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

                if (customerData?.stripeCustomerId) {
                    try {
                        const idempotencyKey = `cancel-booking-${bookingId}-customer-${customerId}`;
                        const stripePresentation = buildStripeChargePresentation({
                            chargeType: "cancellation_fee",
                            bookingId,
                            orderTrackId: bookingData.orderTrackId,
                            amount: cancellationDetails.cancellationCharge,
                            currency: cancellationDetails.currency || "GBP",
                            paymentType: bookingData.paymentType || "card",
                            customer: customerData,
                            agent: {},
                            zoneId: bookingData.zoneId,
                            laundryShopId: bookingData.laundryShopId,
                        });
                        stripeChargeResult = await chargeOffSession(
                            cancellationDetails.cancellationCharge,
                            customerData.stripeCustomerId,
                            savedPaymentMethodId,
                            idempotencyKey,
                            stripePresentation
                        );
                        console.log(`✅ Cancellation charge of ${cancellationDetails.cancellationCharge} ${cancellationDetails.currency} charged to customer ${customerId} for booking ${bookingId}`);
                    } catch (chargeErr) {
                        // Log but don't block the cancellation — admin can follow up on failed charges
                        stripeChargeError = chargeErr.message;
                        console.error(`❌ Failed to charge cancellation fee for booking ${bookingId}:`, chargeErr.message);
                    }
                } else {
                    stripeChargeError = 'No Stripe customer ID found for this customer';
                    console.warn(`⚠️ Cannot charge cancellation fee — no stripeCustomerId for customer ${customerId}`);
                }
            } else {
                stripeChargeError = 'No saved payment method found for this booking';
                console.warn(`⚠️ Cannot charge cancellation fee — no paymentMethodId on booking ${bookingId}`);
            }
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

        // Step 10: Create booking history entry using caller/business timezone wall-clock
        const resolvedTz = this._resolveTimeZone(timeZone);
        const cancellationMoment = moment.tz(resolvedTz);
        await bookingHistory.create({
            bookingId: bookingId,
            bookingStatusId: 19,
            date: cancellationMoment.format('YYYY-MM-DD'),
            time: cancellationMoment.format('HH:mm:ss')
        });

        // Step 11: Process refund if applicable
        let refundDetails = null;
        if (bookingData.paymentConfirmed && cancellationDetails.refundAmount > 0) {
            refundDetails = await this.processRefund(
                customerId,
                bookingId,
                cancellationDetails.refundAmount,
                cancellationDetails.currency
            );
        }

        return {
            bookingId: bookingId,
            status: 'cancelled',
            cancellationCharge: cancellationDetails.cancellationCharge,
            currency: cancellationDetails.currency,
            refundAmount: cancellationDetails.refundAmount,
            totalPaid: bookingData.orderAmount || 0,
            policyApplied: cancellationDetails.policyApplied,
            cancellationReason: cancellationDetails.reason,
            refundProcessed: refundDetails !== null,
            refundDetails: refundDetails,
            cancellationFeeCharged: stripeChargeResult !== null,
            stripeChargeId: stripeChargeResult?.id || null,
            stripeChargeStatus: stripeChargeResult?.status || null,
            stripeChargeError: stripeChargeError,
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
     * @returns {Object} Cancellation charge details
     */
    async calculateCancellationCharge(bookingData, cancellationPolicy, customerId, timeZone = null) {
        const config = cancellationPolicy.cancellationConfig;
        const bookingStatusId = bookingData.bookingStatusId;
        let cancellationCharge = 0;
        let policyApplied = 'No Charge';
        let reason = '';
        let currency = config.prePickupAbsoluteCurrency || 'USD';

        // Pre-Pickup Phase (Status 1-3: Order Created, Confirmed, Awaiting Collection)
        if ([1, 2, 3].includes(bookingStatusId)) {
            const result = await this.calculatePrePickupCharge(bookingData, config, customerId, timeZone);
            cancellationCharge = result.charge;
            policyApplied = result.policyApplied;
            reason = result.reason;
            currency = config.prePickupAbsoluteCurrency;
        }
        // Unprocessed Phase (Status 4-10: Driver out, picked up, in transit, not yet processing)
        else if ([4, 5, 6, 7, 8, 9, 10].includes(bookingStatusId)) {
            if (!config.allowCancelUnprocessed) {
                throw new ValidationError("Cancellation is not allowed at this stage according to the policy");
            }

            const result = await this.calculateUnprocessedCharge(bookingData, config, customerId);
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

        // Calculate refund amount
        const totalPaid = parseFloat(bookingData.orderAmount || 0);
        const refundAmount = Math.max(0, totalPaid - cancellationCharge);

        return {
            cancellationCharge: parseFloat(cancellationCharge.toFixed(2)),
            refundAmount: parseFloat(refundAmount.toFixed(2)),
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
     * @returns {Object} Charge details
     */
    async calculatePrePickupCharge(bookingData, config, customerId, timeZone = null) {
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

        // Calculate charge
        let charge = 0;
        if (config.prePickupAbsoluteAmount) {
            charge = parseFloat(config.prePickupAbsoluteAmount);
        }

        if (config.prePickupPercentage && bookingData.orderAmount) {
            const percentageCharge = (parseFloat(bookingData.orderAmount) * parseFloat(config.prePickupPercentage)) / 100;
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
     * @returns {Object} Charge details
     */
    async calculateUnprocessedCharge(bookingData, config, customerId) {
        let charge = 0;

        // Apply absolute amount
        if (config.unprocessedAbsoluteAmount) {
            charge = parseFloat(config.unprocessedAbsoluteAmount);
        }

        // Apply percentage of order value
        if (config.unprocessedOrderValuePercentage && bookingData.orderAmount) {
            const percentageCharge = (parseFloat(bookingData.orderAmount) * parseFloat(config.unprocessedOrderValuePercentage)) / 100;
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
     * Process refund to customer wallet
     * @param {number} customerId - Customer ID
     * @param {number} bookingId - Booking ID
     * @param {number} refundAmount - Amount to refund
     * @param {string} currency - Currency
     * @returns {Object} Refund details
     */
    async processRefund(customerId, bookingId, refundAmount, currency) {
        // Create wallet entry for refund
        const walletEntry = await wallet.create({
            userId: customerId,
            bookingId: bookingId,
            amount: refundAmount,
            type: 'credit',
            description: `Refund for cancelled booking #${bookingId}`,
            currency: currency,
            status: 'completed'
        });

        return {
            walletTransactionId: walletEntry.id,
            refundAmount: refundAmount,
            currency: currency,
            processedAt: moment().format('YYYY-MM-DD HH:mm:ss')
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


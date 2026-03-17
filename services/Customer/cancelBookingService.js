const { booking, cancelBooking, users, policy, cancellationPolicyConfig, bookingHistory, wallet } = require('../../models');
const { Op } = require('sequelize');
const moment = require('moment');
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
    
    /**
     * Cancel a booking with policy-based charge calculation
     * @param {number} bookingId - Booking ID to cancel
     * @param {number} customerId - Customer ID requesting cancellation
     * @param {number} reasonId - Optional reason ID
     * @param {string} reasonText - Cancellation reason text
     * @returns {Object} Cancellation result with charges
     */
    async cancelCustomerBooking(bookingId, customerId, reasonId = null, reasonText) {
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
                'collectionDate', 
                'collectionTimeFrom',
                'orderAmount',
                'paymentConfirmed',
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

        // Step 5: Get active cancellation policy
        const activeCancellationPolicy = await this.getActiveCancellationPolicy();

        // Step 6: Calculate cancellation charges based on policy
        const cancellationDetails = await this.calculateCancellationCharge(
            bookingData,
            activeCancellationPolicy,
            customerId
        );

        // Step 7: Create cancellation record
        await cancelBooking.create({
            bookingId: bookingId,
            reasonId: reasonId,
            reasonText: reasonText,
            userId: customerId
        });

        // Step 8: Update booking status to Cancelled (19) and set cancellation policy ID
        await booking.update(
            { 
                bookingStatusId: 19,
                cancellationPolicyId: activeCancellationPolicy?.id || null
            },
            { where: { id: bookingId } }
        );

        // Step 9: Create booking history entry
        await bookingHistory.create({
            bookingId: bookingId,
            bookingStatusId: 19,
            date: moment().format('YYYY-MM-DD'),
            time: moment().format('HH:mm:ss')
        });

        // Step 10: Process refund if applicable
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
            message: cancellationDetails.message
        };
    }

    /**
     * Get active cancellation policy
     * @returns {Object} Active cancellation policy with config
     */
    async getActiveCancellationPolicy() {
        const activePolicy = await policy.findOne({
            where: {
                type: 'cancellation',
                isActive: true,
                isDefault: true
            },
            include: [
                {
                    model: cancellationPolicyConfig,
                    as: 'cancellationConfig',
                    required: true
                }
            ]
        });

        if (!activePolicy) {
            // Return default policy if none is configured
            return {
                cancellationConfig: {
                    prePickupFreeChargeWindowMinutes: 120,
                    prePickupFirstCancellationLeniency: true,
                    prePickupAbsoluteAmount: 0,
                    prePickupPercentage: 0,
                    unprocessedAbsoluteAmount: 30,
                    unprocessedPercentage: 0,
                    unprocessedAfterPickupMinutes: 30,
                    unprocessedOrderValuePercentage: 15,
                    allowCancelUnprocessed: true,
                    courtesyWindowDays: 30,
                    courtesyCapAmount: 15,
                    courtesyCount: 1,
                    customerLeniencyEnabled: true,
                    prePickupAbsoluteCurrency: 'USD',
                    unprocessedAbsoluteCurrency: 'USD'
                }
            };
        }

        return activePolicy;
    }

    /**
     * Calculate cancellation charge based on policy and booking status
     * @param {Object} bookingData - Booking data
     * @param {Object} cancellationPolicy - Cancellation policy
     * @param {number} customerId - Customer ID
     * @returns {Object} Cancellation charge details
     */
    async calculateCancellationCharge(bookingData, cancellationPolicy, customerId) {
        const config = cancellationPolicy.cancellationConfig;
        const bookingStatusId = bookingData.bookingStatusId;
        let cancellationCharge = 0;
        let policyApplied = 'No Charge';
        let reason = '';
        let currency = config.prePickupAbsoluteCurrency || 'USD';

        // Pre-Pickup Phase (Status 1-3: Order Created, Confirmed, Awaiting Collection)
        if ([1, 2, 3].includes(bookingStatusId)) {
            const result = await this.calculatePrePickupCharge(bookingData, config, customerId);
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
     * Calculate pre-pickup cancellation charge
     * @param {Object} bookingData - Booking data
     * @param {Object} config - Policy config
     * @param {number} customerId - Customer ID
     * @returns {Object} Charge details
     */
    async calculatePrePickupCharge(bookingData, config, customerId) {
        // Combine collection date and time
        const collectionDateTime = moment(
            `${moment(bookingData.collectionDate).format('YYYY-MM-DD')} ${bookingData.collectionTimeFrom}`,
            'YYYY-MM-DD HH:mm:ss'
        );

        const now = moment();
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


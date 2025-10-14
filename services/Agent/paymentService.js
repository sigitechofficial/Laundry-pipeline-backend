require("dotenv").config();
const { booking, billingDetails } = require('../../models');
const { createPaymentIntentForAgent } = require('../../controllers/stripe');
const { 
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError 
} = require('../../middlewares/universalErrorHandler');

/**
 * Agent Payment Service
 * Handles all agent payment related business logic
 */
class AgentPaymentService {

    /**
     * Create Intent Using Stripe For Agent
     * @param {Object} data - Payment intent data
     * @param {number} data.amount - Payment amount
     * @param {string} data.customerId - Customer ID
     * @param {string} data.savedPaymentMethodId - Saved payment method ID
     * @returns {Object} Payment intent result
     */
    async createIntentUsingStripeForAgent(data) {
        const { amount, customerId, savedPaymentMethodId } = data;
        console.log("Amount ------------------------>", amount)
        const intent = await createPaymentIntentForAgent(amount, customerId, savedPaymentMethodId);
        console.log("🚀 ~ createIntentUsingStripe ~ intent:", intent)

        const intentData = {
            intentId: intent.id,
            amount: intent.amount,
            customerId: customerId,
        };

        return {
            intentData,
            message: "Intent Created"
        };
    }

    /**
     * Booking Invoice Generated Status Updated
     * @param {Object} data - Status update data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Status update result
     */
    async bookingInvoiceGeneratedStatusUpdated(data) {
        const { bookingId } = data;

        const bookingCheck = await booking.findOne({
            where: {
                id: bookingId,
            },
        });

        if (!bookingCheck) {
            throw new NotFoundError("Booking not found");
        }

        if (bookingCheck.bookingStatusId !== 9) {
            throw new ValidationError("Booking is still not In Transit to Facility");
        }

        await booking.update(
            {
                bookingStatusId: 11,
                paymentConfirmed: true,
            },
            { where: { id: bookingId } }
        );

        await billingDetails.update(
            {
                paymentStatus: "Paid",
            },
            { where: { bookingId: bookingId } }
        );

        const currentTime = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        return {
            message: "Booking invoice generated status updated",
            bookingId: bookingId,
            status: 11,
            paymentConfirmed: true,
            time: currentTime
        };
    }
}

module.exports = new AgentPaymentService();

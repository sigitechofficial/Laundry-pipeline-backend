require("dotenv").config();
const { booking, billingDetails } = require('../../models');
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

        // 8 = Delivered to shop, 9 = services added, 10 = invoice generated (retry / legacy)
        const allowedForInvoiceGenerate = [8, 9, 10];
        if (!allowedForInvoiceGenerate.includes(bookingCheck.bookingStatusId)) {
            throw new ValidationError(
                "Booking must be at the laundry shop (invoice stage) before generating the invoice"
            );
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

        const agentWalletService = require('./agentWalletService');
        try {
            await agentWalletService.creditAgentForPaidBooking(bookingId);
        } catch (walletErr) {
            console.error(
                `[agentWallet] credit failed for booking ${bookingId}:`,
                walletErr.message
            );
        }

        const currentTime = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        return {
            bookingId: bookingId,
            status: 11,
            paymentConfirmed: true,
            time: currentTime
        };
    }
}

module.exports = new AgentPaymentService();

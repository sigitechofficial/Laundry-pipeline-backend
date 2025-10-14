require("dotenv").config();
const { 
    OnHoldConfirmation, 
    booking, 
    service, 
    subCategories 
} = require('../../models');
const { Op } = require('sequelize');
const { 
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError 
} = require('../../middlewares/universalErrorHandler');

/**
 * Agent On-Hold Management Service
 * Handles all agent on-hold related business logic
 */
class AgentOnHoldManagementService {

    /**
     * On Hold Confirmation
     * @param {Object} data - On hold confirmation data
     * @param {Array} data.records - Records array
     * @param {Array} images - On hold images
     * @returns {Object} On hold confirmation result
     */
    async onHoldConformation(data, images) {
        let records = [];

        // Parse incoming records safely
        if (!data.records) {
            throw new ValidationError("Missing 'records' in request body.");
        }
        records = JSON.parse(data.records);
        console.log("records===============================>>>>>>>>", records);

        const currentTime = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        const currentDate = new Date().toISOString().split("T")[0];
        console.log("Current Date:", currentDate);

        const responseData = [];

        for (let i = 0; i < records.length; i++) {
            const { serviceId, subCategoryId, bookingId, noOfItems, description } = records[i];

            // Match the uploaded image by index, not from records[i].onHoldImg
            let onHoldImg = "";
            if (images && images[i]) {
                console.log("Images get ==========================================>>>>")
                onHoldImg = images[i].replace(/\\/g, "/");
            }

            // Store in DB
            const createConformation = await OnHoldConfirmation.create({
                serviceId,
                subCategoryId,
                bookingId,
                noOfItems,
                description,
                onHoldImg,
            });

            await booking.update(
                { bookingStatusId: 18 },
                { where: { id: bookingId } }
            );

            responseData.push({
                id: createConformation.id,
                serviceId,
                subCategoryId,
                bookingId,
                noOfItems,
                description,
                onHoldImg
            });
        }

        return {
            responseData,
            message: "On hold confirmation created successfully"
        };
    }

    /**
     * Get Rejected Service Items
     * @param {Object} data - Rejected items data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Rejected service items
     */
    async rejectedServiceItems(data) {
        const { bookingId } = data;

        const rejectedItems = await OnHoldConfirmation.findAll({
            where: {
                bookingId: bookingId,
            },
            include: [
                {
                    model: service,
                    attributes: ['id', 'name']
                },
                {
                    model: subCategories,
                    attributes: ['id', 'name', 'price']
                }
            ],
            attributes: ['id', 'noOfItems', 'description', 'serviceId', 'subCategoryId', 'customerResponse', 'deleted']
        });

        if (rejectedItems.length === 0) {
            return {
                rejectedItems: [],
                message: "No rejected items found"
            };
        }

        if (rejectedItems[0].customerResponse === true && rejectedItems[0].deleted === true) {
            return {
                rejectedItems: [],
                message: "Rejected Services Items"
            };
        }

        return {
            rejectedItems,
            message: "Rejected Services Items"
        };
    }

    /**
     * Agent Issue Resolved
     * @param {Object} data - Issue resolution data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Issue resolution result
     */
    async agentIssueResolved(data) {
        const { bookingId } = data;

        const bookingCheck = await booking.findOne({
            where: {
                id: bookingId,
            },
        });

        if (!bookingCheck) {
            throw new NotFoundError("Booking not found");
        }

        if (bookingCheck.bookingStatusId !== 22) {
            throw new ValidationError("Booking customer Response is not confirmed");
        }

        await booking.update(
            { bookingStatusId: 19 },
            { where: { id: bookingId } }
        );

        return {
            message: "Issue resolved successfully"
        };
    }
}

module.exports = new AgentOnHoldManagementService();

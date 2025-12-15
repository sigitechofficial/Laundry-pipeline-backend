require("dotenv").config();
const { 
    booking, 
    addressDb, 
    bookingStatus, 
    countries, 
    cities, 
    customerSelectedService,
    service,
    servicePreferences,
    categories,
    subCategories,
    zone,
    users
} = require('../../models');
const { Op } = require('sequelize');
const { 
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError 
} = require('../../middlewares/universalErrorHandler');

/**
 * Agent Invoice Management Service
 * Handles all agent invoice related business logic
 */
class AgentInvoiceManagementService {

    /**
     * Get Invoice Detail Tab
     * @param {number} agentId - Agent ID
     * @returns {Object} Invoice details data
     */
    async invoiceDetailTab(agentId) {
        const addressFound = await addressDb.findOne({
            where: { userId: agentId },
        });

        if (!addressFound) {
            throw new NotFoundError("Address not found for agent");
        }

        const results = {};

        // All bookings (any booking with this laundryShopId)
        results.All = await booking.findAll({
            where: {
                laundryShopId: addressFound.id,
                bookingStatusId: 8
            },
            attributes: [
                "id",
                "ordertrackId",
                "collectionTimeFrom",
                "collectiontimeTo",
                "collectionDate",
                "deliveryTimeFrom",
                "deliveryTimeTo",
                "deliveryDate",
                "driverInstructionOptions",
                "driverInstructionOptions1",
                "bookingStatusId"
            ],
            include: [
                {
                    model: bookingStatus,
                    attributes: ['id', 'title', 'description']
                },
                {
                    model: addressDb,
                    as: "laundryShop",
                    attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                    include: [
                        {
                            model: countries,
                            attributes: ['id', 'name', 'shortName']
                        },
                        {
                            model: cities,
                            attributes: ['id', 'name']
                        }
                    ]
                },
                {
                    model: users,
                    as: "customer",
                    attributes: ["firstName", "lastName", "email", "phoneNum", "image"]
                }
            ]
        });

        return {
            results,
        };
    }

    /**
     * Driver Add Services
     * @param {Object} data - Services data
     * @param {Array} data.services - Services array
     * @param {number} data.bookingId - Booking ID
     * @param {number} data.zoneMinimumAmount - Zone minimum amount
     * @param {number} data.serviceCharge - Service charge
     * @returns {Object} Services addition result
     */
    async driverAddSerivces(data) {
        const { services, bookingId, zoneMinimumAmount, serviceCharge } = data;

        if (!Array.isArray(services) || services.length === 0) {
            throw new ValidationError("Invalid request. Please provide an array of services.");
        }

        const currentTime = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        const currentDate = new Date().toISOString().split("T")[0];

        // Fetch booking with zone information
        const bookings = await booking.findByPk(bookingId, {
            include: [
                {
                    model: zone,
                    attributes: ['id', 'name', 'zoneAdminComission']
                }
            ]
        });

        if (!bookings) {
            throw new NotFoundError("Booking not found");
        }

        // Get zone information directly from booking
        const zoneData = bookings.zone;
        if (!zoneData) {
            throw new NotFoundError("Zone information not found for this booking");
        }

        let total = 0;

        if (services.length > 0) {
            for (let service of services) {
                const itemTotalPrice = parseFloat(service.categoryCharge || 0);
                total += itemTotalPrice;

                const existingRecords = await customerSelectedService.findAll({
                    where: {
                        bookingId,
                        serviceId: service.serviceId,
                        subCategoryId: { [Op.is]: null },
                        categoryId: { [Op.is]: null },
                    }
                });

                if (existingRecords.length > 0) {
                    await customerSelectedService.update(
                        {
                            categoryCharge: service.categoryCharge,
                            totalPrice: service.categoryCharge,
                            updatedAt: new Date()
                        },
                        {
                            where: {
                                bookingId,
                                serviceId: service.serviceId,
                                subCategoryId: { [Op.is]: null },
                                categoryId: { [Op.is]: null },
                            }
                        }
                    );
                } else {
                    await customerSelectedService.create({
                        bookingId: bookingId,
                        serviceId: service.serviceId,
                        categoryCharge: service.categoryCharge,
                        totalPrice: service.categoryCharge,
                        status: true,
                        createdAt: new Date(),
                        updatedAt: new Date()
                    });
                }
            }
        }

        // Update booking with total amount
        await booking.update(
            {
                totalAmount: total,
                zoneMinimumAmount: zoneMinimumAmount,
                serviceCharge: serviceCharge,
                updatedAt: new Date()
            },
            {
                where: { id: bookingId }
            }
        );

        return {
            total,
        };
    }

    /**
     * Invoice Creation
     * @param {Object} data - Invoice creation data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Invoice creation result
     */
    async invoiceCreation(data) {
        const { bookingId } = data;

        const invoiceDetails = await booking.findAll({
            where: { id: bookingId },
            include: [
                {
                    model: zone,
                    attributes: ['id', 'name', 'zoneMinimumAmount', 'serviceCharge']
                },
                {
                    model: users,
                    as: "customer",
                    attributes: ["firstName", "lastName", "email", "phoneNum", "image", "stripeCustomerId"]
                },
                {
                    model: addressDb,
                    as: "pickupAddress",
                    attributes: [
                        "title", "streetAddress", "district", "province", "postalcode", "addressType"
                    ],
                    include: [
                        { model: countries, attributes: ["name", "shortName"] },
                        { model: cities, attributes: ['id', "name"] }
                    ]
                },
                {
                    model: addressDb,
                    as: "dropOffAddress",
                    attributes: [
                        "title", "streetAddress", "district", "province", "postalcode", "addressType"
                    ],
                    include: [
                        { model: countries, attributes: ["name", "shortName"] },
                        { model: cities, attributes: ['id', "name"] }
                    ]
                },
                {
                    model: customerSelectedService,
                    required: false,
                    include: [
                        {
                            model: service,
                            required: false,
                            attributes: { exclude: ["createdAt", "updatedAt", "timeRequired"] },
                            include: [
                                {
                                    model: servicePreferences,
                                    required: false,
                                    where: {
                                        bookingId: bookingId
                                    },
                                    attributes: ['id', 'type', 'chooseTemperature', 'numberOfBags', 'preferencesServiceNameId', 'serviceId']
                                }
                            ]
                        },
                        {
                            model: categories,
                            required: false,
                            attributes: ['id', 'name', 'image', 'description']
                        },
                        {
                            model: subCategories,
                            required: false,
                            attributes: ['id', 'name', 'price', 'description']
                        }
                    ]
                }
            ]
        });

        if (!invoiceDetails || invoiceDetails.length === 0) {
            throw new NotFoundError("Invoice details not found");
        }

        return {
            invoiceDetails,
        };
    }

    /**
     * Agent Update Invoice
     * @param {Object} data - Invoice update data
     * @param {number} data.bookingId - Booking ID
     * @param {number} data.totalAmount - Total amount
     * @param {number} data.serviceCharge - Service charge
     * @param {number} data.zoneMinimumAmount - Zone minimum amount
     * @returns {Object} Invoice update result
     */
    async agentUpdateInvoice(data) {
        const { bookingId, totalAmount, serviceCharge, zoneMinimumAmount } = data;

        const bookingfind = await booking.findOne({
            where: { id: bookingId }
        });

        if (!bookingfind) {
            throw new NotFoundError("Booking not found");
        }

        await booking.update(
            {
                totalAmount: totalAmount,
                serviceCharge: serviceCharge,
                zoneMinimumAmount: zoneMinimumAmount,
                updatedAt: new Date()
            },
            {
                where: { id: bookingId }
            }
        );

        return {
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

        const bookingfind = await booking.findOne({
            where: { id: bookingId }
        });

        if (!bookingfind) {
            throw new NotFoundError("Booking not found");
        }

        await booking.update(
            {
                invoiceGenerated: true,
                invoiceGeneratedAt: new Date(),
                updatedAt: new Date()
            },
            {
                where: { id: bookingId }
            }
        );

        return {
        };
    }

    /**
     * Update Invoice
     * @param {Object} data - Invoice update data
     * @param {number} data.bookingId - Booking ID
     * @param {number} data.totalAmount - Total amount
     * @param {number} data.serviceCharge - Service charge
     * @param {number} data.zoneMinimumAmount - Zone minimum amount
     * @param {Array} data.services - Services array
     * @returns {Object} Invoice update result
     */
    async updateInvoice(data) {
        const { bookingId, totalAmount, serviceCharge, zoneMinimumAmount, services } = data;

        const bookingfind = await booking.findOne({
            where: { id: bookingId }
        });

        if (!bookingfind) {
            throw new NotFoundError("Booking not found");
        }

        // Update booking
        await booking.update(
            {
                totalAmount: totalAmount,
                serviceCharge: serviceCharge,
                zoneMinimumAmount: zoneMinimumAmount,
                updatedAt: new Date()
            },
            {
                where: { id: bookingId }
            }
        );

        // Update services if provided
        if (services && services.length > 0) {
            for (let service of services) {
                await customerSelectedService.update(
                    {
                        categoryCharge: service.categoryCharge,
                        totalPrice: service.totalPrice,
                        updatedAt: new Date()
                    },
                    {
                        where: {
                            bookingId: bookingId,
                            serviceId: service.serviceId
                        }
                    }
                );
            }
        }

        return {
        };
    }
}

module.exports = new AgentInvoiceManagementService();

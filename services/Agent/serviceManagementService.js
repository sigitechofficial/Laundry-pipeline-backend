require("dotenv").config();
const { 
    agentSelectServices, 
    service, 
    users, 
    serviceCategories,
    categories,
    subCategories,
    customerSelectedService,
    servicePreferences
} = require('../../models');
const { Op } = require('sequelize');
const { 
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError 
} = require('../../middlewares/universalErrorHandler');
const { sumActiveBookingServicesSubtotal } = require('../../utils/invoiceLineTotals');

/**
 * Agent Service Management Service
 * Handles all agent service related business logic
 */
class AgentServiceManagementService {

    /**
     * Get Agent Services
     * @param {number} agentId - Agent ID
     * @returns {Object} Agent services data
     */
    async getAgentServices(agentId) {
        const findServices = await agentSelectServices.findAll({
            where: {
                agentServiceId: agentId,
            },
            include: [
                {
                    model: service,
                    attributes: [
                        'id',
                        'name',
                        'image',
                        'description',
                        'timeRequired',
                        'pricingBasis',
                        'numberOfBags',
                        'numberOfItems',
                    ],
                },
                {
                    model: users,
                    as: "agentServices",
                    attributes: ["firstName", "lastName", "email"],
                },
            ],
        });

        return {
            findServices,
        };
    }

    /**
     * Edit Service Status
     * @param {Object} data - Service status data
     * @param {number} data.serviceId - Service ID
     * @param {boolean} data.status - Service status
     * @param {number} agentId - Agent ID
     * @returns {Object} Status update result
     */
    async editServiceStatus(data, agentId) {
        const { serviceId, status } = data;

        const serviceFind = await agentSelectServices.findOne({
            where: {
                serviceId: serviceId,
                agentServiceId: agentId
            }
        });

        if (!serviceFind) {
            throw new NotFoundError("Service Not Found");
        }

        await agentSelectServices.update(
            { status: status },
            { where: { serviceId: serviceId, agentServiceId: agentId } }
        );

        return {
        };
    }

    /**
     * Get Service Details
     * @param {number} agentId - Agent ID
     * @returns {Object} Service details data
     */
    async serviceDetail(agentId) {
        const agentServiceFind = await agentSelectServices.findAll({
            where: {
                agentServiceId: agentId,
                status: true
            },
            attributes: ['serviceId']
        });

        const serviceIds = agentServiceFind.map(service => service.serviceId);

        const serviceData = await serviceCategories.findAll({
            where: {
                serviceId: { [Op.in]: serviceIds },
                status: true
            },
            include: [
                {
                    model: service,
                    attributes: [
                        'id',
                        'name',
                        'status',
                        'image',
                        'description',
                        'timeRequired',
                        'pricingBasis',
                        'numberOfBags',
                        'numberOfItems',
                    ],
                },
                {
                    model: categories,
                    attributes: ['id', 'name', 'status', 'image', 'description'],
                    include: [
                        {
                            model: subCategories,
                            attributes: ['id', 'name', 'status', 'price', 'description']
                        }
                    ]
                }
            ]
        });

        const grouped = {};

        for (const item of serviceData) {
            const serviceId = item.service.id;
            const serviceName = item.service.name;
            const image = item.service.image;

            if (!grouped[serviceId]) {
                grouped[serviceId] = {
                    serviceId: serviceId,
                    serviceName: serviceName,
                    image: image,
                    categories: []
                };
            }

            const category = {
                categoryId: item.categories.id,
                categoryName: item.categories.name,
                categoryImage: item.categories.image,
                categoryDescription: item.categories.description,
                subCategories: item.categories.subCategories || []
            };

            // Check if category already exists
            const existingCategory = grouped[serviceId].categories.find(cat => cat.categoryId === category.categoryId);
            if (!existingCategory) {
                grouped[serviceId].categories.push(category);
            }
        }

        const result = Object.values(grouped);

        return {
            serviceDetails: result,
        };
    }

    /**
     * Get Customer Services
     * @param {Object} data - Customer services data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Customer services data
     */
    async customerServices(data) {
        const { bookingId } = data;

        const customerServicesFind = await customerSelectedService.findAll({
            where: {
                bookingId: bookingId,
                status: true
            },
            include: [
                {
                    model: service,
                    attributes: ["id", "name"],
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
                    attributes: ["id", "name"],
                },
                {
                    model: subCategories,
                    attributes: ["id", "name", "price"],
                },
            ],
            attributes: ['id', 'categoryPrice', 'items']
        });

        if (!customerServicesFind || customerServicesFind.length === 0) {
            throw new NotFoundError("No Customer Selected Services");
        }

        const totalAmount = await sumActiveBookingServicesSubtotal(bookingId);

        return {
            customerServices: customerServicesFind,
            totalAmount: totalAmount,
        };
    }

    /**
     * Get Customer Services to Update Invoice
     * @param {Object} data - Invoice update data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Customer services for invoice update
     */
    async getCustomerServicestoUpdateInvoice(data) {
        const { bookingId } = data;

        const customerServicesFind = await customerSelectedService.findAll({
            where: {
                bookingId: bookingId,
                status: true
            },
            include: [
                {
                    model: service,
                    attributes: ["id", "name"],
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
                    attributes: ["id", "name"],
                },
                {
                    model: subCategories,
                    attributes: ["id", "name", "price"],
                },
            ],
            attributes: ['id', 'categoryPrice', 'items', 'quantity', 'totalPrice']
        });

        if (!customerServicesFind || customerServicesFind.length === 0) {
            return {
                customerServices: [],
                totalAmount: 0,
                message: "No services found for invoice update"
            };
        }

        const totalAmount = await sumActiveBookingServicesSubtotal(bookingId);

        return {
            customerServices: customerServicesFind,
            totalAmount: totalAmount,
        };
    }
}

module.exports = new AgentServiceManagementService();

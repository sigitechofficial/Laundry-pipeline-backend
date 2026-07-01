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

const SERVICE_LIST_ATTRIBUTES = [
    'id',
    'name',
    'image',
    'description',
    'timeRequired',
    'pricingBasis',
    'numberOfBags',
    'numberOfItems',
];

function normalizeAgentServiceStatus(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}

/**
 * Agent Service Management Service
 * Handles all agent service related business logic
 */
class AgentServiceManagementService {

    /**
     * Get Agent Services — all platform services; unselected / new ones return status false.
     * @param {number} agentId - Agent ID
     * @returns {Object} Agent services data
     */
    async getAgentServices(agentId) {
        const [platformServices, agentRows, agentUser] = await Promise.all([
            service.findAll({
                where: { status: true },
                attributes: [...SERVICE_LIST_ATTRIBUTES, 'sortOrder'],
                order: [
                    ['sortOrder', 'ASC'],
                    ['id', 'ASC'],
                ],
            }),
            agentSelectServices.findAll({
                where: { agentServiceId: agentId },
            }),
            users.findByPk(agentId, {
                attributes: ['firstName', 'lastName', 'email'],
            }),
        ]);

        const agentByServiceId = new Map();
        for (const row of agentRows) {
            const plain = row.toJSON ? row.toJSON() : row;
            agentByServiceId.set(plain.serviceId, plain);
        }

        const agentUserPlain = agentUser
            ? agentUser.toJSON
                ? agentUser.toJSON()
                : agentUser
            : null;

        const findServices = platformServices.map((svc) => {
            const svcPlain = svc.toJSON ? svc.toJSON() : svc;
            const agentRow = agentByServiceId.get(svcPlain.id);

            return {
                id: agentRow?.id ?? null,
                status: agentRow ? Boolean(agentRow.status) : false,
                serviceTimeRequired: agentRow?.serviceTimeRequired ?? 'N/A',
                serviceId: svcPlain.id,
                agentServiceId: agentId,
                createdAt: agentRow?.createdAt ?? null,
                updatedAt: agentRow?.updatedAt ?? null,
                deletedAt: agentRow?.deletedAt ?? null,
                service: svcPlain,
                agentServices: agentUserPlain,
            };
        });

        return { findServices };
    }

    /**
     * Edit Service Status — update existing row or create when agent activates a new service.
     * @param {Object} data - Service status data
     * @param {number} data.serviceId - Service ID
     * @param {boolean} data.status - Service status
     * @param {number} agentId - Agent ID
     * @returns {Object} Status update result
     */
    async editServiceStatus(data, agentId) {
        const { serviceId, status } = data;

        if (!serviceId) {
            throw new ValidationError('serviceId is required');
        }

        const platformSvc = await service.findOne({
            where: { id: serviceId, status: true },
        });

        if (!platformSvc) {
            throw new NotFoundError('Service not found');
        }

        const normalizedStatus = normalizeAgentServiceStatus(status);

        const existing = await agentSelectServices.findOne({
            where: {
                serviceId,
                agentServiceId: agentId,
            },
        });

        if (existing) {
            await existing.update({ status: normalizedStatus });
            return {};
        }

        if (!normalizedStatus) {
            return {};
        }

        await agentSelectServices.create({
            serviceId,
            agentServiceId: agentId,
            status: true,
            serviceTimeRequired: 'N/A',
        });

        return {};
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

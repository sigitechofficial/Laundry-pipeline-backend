require("dotenv").config();
const { 
    users, 
    userType, 
    otpVerification, 
    deviceToken, 
    features, 
    bussinessInformation, 
    bussinessWorkingHours, 
    service, 
    machines, 
    machineCount, 
    addressDb, 
    zone, 
    units,
    agentSelectServices
} = require('../../models');
const sequelize = require('sequelize');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const redisCli = require('../../redis/redis');
const { 
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError,
    UnprocessableEntityError 
} = require('../../middlewares/universalErrorHandler');
const stripe = require('../../controllers/stripe');

/**
 * Agent Registration Service
 * Handles complete agent registration process for admin side
 */
class AgentRegistrationService {
    
    /**
     * Register Agent (Complete Setup)
     * @param {Object} data - Registration data
     * @param {string} profileImg - Profile image path
     * @returns {Object} Registration result
     */
    async registerAgent(data, profileImg = null) {
        const { 
            firstName, 
            lastName, 
            password, 
            phoneNum, 
            countryId, 
            cityId, 
            email, 
            countryCode,
            // Business Information
            shopName,
            matchProfileOptions,
            otherText,
            machineryCount,
            serviceTimes,
            // Address Information
            streetAddress,
            province,
            postalCode,
            district,
            lat,
            lng,
            coordinates,
            addressType,
            zoneId,
            // Services
            services
        } = data;

        // Check if user already exists
        const existingUser = await users.findOne({
            where: {
                email: email,
                deletedAt: {
                    [Op.is]: null
                }
            }
        });

        if (existingUser && existingUser.userTypeId === 4) {
            throw new ConflictError("Agent already exists with this email");
        }

        // Validate business information
        if (matchProfileOptions !== 'Other' && otherText) {
            throw new ValidationError('You can Add this Field Only when Select Other Option');
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 8);
        
        // Create user with agent type (userTypeId: 4)
        const userCreate = await users.create({
            email,
            firstName,
            lastName,
            phoneNum,
            userTypeId: 4, // Agent type
            password: hashedPassword,
            status: true,
            countryCode,
            verifiedAt: new Date(), // Skip OTP verification for admin registration
            image: profileImg,
            countryId,
            cityId
        });

        // Create Stripe customer
        const stripeCustomer = await stripe.createStripeCustomer(firstName, email);
        
        // Update user with Stripe customer ID
        await users.update({
            stripeCustomerId: stripeCustomer
        }, {
            where: { id: userCreate.id }
        });

        // Create default business working hours for all days
        const daysArray = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const workingHoursData = daysArray.map((day) => ({
            dayOfWeek: day,
            status: true,
            userId: userCreate.id
        }));
        
        await bussinessWorkingHours.bulkCreate(workingHoursData);

        // Create address if provided
        let addressId = null;
        if (streetAddress && zoneId) {
            const address = await addressDb.create({
                streetAddress,
                province,
                postalCode,
                district,
                lat,
                lng,
                coordinates,
                addressType: addressType || 'Business',
                userId: userCreate.id,
                zoneId
            });
            addressId = address.id;
        }

        // Create business information
        const businessInfoData = {
            shopName,
            matchProfileOptions,
            agentId: userCreate.id,
            shopAddressId: addressId
        };

        if (matchProfileOptions === 'Other' && otherText) {
            businessInfoData.otherText = otherText;
        }

        const agentInfo = await bussinessInformation.create(businessInfoData);

        // Create machine count if provided
        if (machineryCount && machineryCount.length > 0) {
            const machinesCountCreate = machineryCount.map(ele => ({
                total: ele.total,
                status: true,
                machineId: ele.machineId,
                bussinessInformationId: agentInfo.id
            }));
            
            await machineCount.bulkCreate(machinesCountCreate);
        }

        // Create agent services if provided
        if (services && services.length > 0) {
            const servicesToCreate = services.map(service => ({
                serviceId: service.serviceId,
                status: true,
                agentServiceId: userCreate.id
            }));

            await agentSelectServices.bulkCreate(servicesToCreate);

            // Update service times if provided
            if (serviceTimes && serviceTimes.length > 0) {
                await Promise.all(
                    serviceTimes.map(async (ele) => {
                        await agentSelectServices.update({
                            serviceTimeRequired: ele.serviceTimeRequired
                        }, { 
                            where: { 
                                agentServiceId: userCreate.id, 
                                serviceId: ele.serviceId 
                            } 
                        });
                    })
                );
            }
        }

        // Update user with business information ID
        await users.update({
            bussinessInformationId: agentInfo.id
        }, {
            where: { id: userCreate.id }
        });

        return {
            userId: userCreate.id,
            email: userCreate.email,
            firstName: userCreate.firstName,
            lastName: userCreate.lastName,
            stripeCustomerId: stripeCustomer,
            businessInfoId: agentInfo.id,
            addressId: addressId
        };
    }

    /**
     * Add Business Information to Existing Agent
     * @param {Object} data - Business information data
     * @param {number} userId - User ID
     * @returns {Object} Result
     */
    async addBusinessInformation(data, userId) {
        const { 
            shopName, 
            matchProfileOptions, 
            otherText, 
            machineryCount, 
            serviceTimes,
            streetAddress,
            province,
            postalCode,
            district,
            lat,
            lng,
            coordinates,
            addressType,
            zoneId
        } = data;

        // Validate business information
        if (matchProfileOptions !== 'Other' && otherText) {
            throw new ValidationError('You can Add this Field Only when Select Other Option');
        }

        // Check if user exists
        const user = await users.findByPk(userId);
        if (!user) {
            throw new NotFoundError('User not found');
        }

        // Create address if provided
        let addressId = null;
        if (streetAddress && zoneId) {
            const address = await addressDb.create({
                streetAddress,
                province,
                postalCode,
                district,
                lat,
                lng,
                coordinates,
                addressType: addressType || 'Business',
                userId: userId,
                zoneId
            });
            addressId = address.id;
        }

        // Create business information
        const businessInfoData = {
            shopName,
            matchProfileOptions,
            agentId: userId,
            shopAddressId: addressId
        };

        if (matchProfileOptions === 'Other' && otherText) {
            businessInfoData.otherText = otherText;
        }

        const agentInfo = await bussinessInformation.create(businessInfoData);

        // Create machine count if provided
        if (machineryCount && machineryCount.length > 0) {
            const machinesCountCreate = machineryCount.map(ele => ({
                total: ele.total,
                status: true,
                machineId: ele.machineId,
                bussinessInformationId: agentInfo.id
            }));
            
            await machineCount.bulkCreate(machinesCountCreate);
        }

        // Update service times if provided
        if (serviceTimes && serviceTimes.length > 0) {
            await Promise.all(
                serviceTimes.map(async (ele) => {
                    await agentSelectServices.update({
                        serviceTimeRequired: ele.serviceTimeRequired
                    }, { 
                        where: { 
                            agentServiceId: userId, 
                            serviceId: ele.serviceId 
                        } 
                    });
                })
            );
        }

        // Update user with business information ID
        await users.update({
            bussinessInformationId: agentInfo.id
        }, {
            where: { id: userId }
        });

        return {
            businessInfoId: agentInfo.id,
            addressId: addressId
        };
    }

    /**
     * Add Services to Agent
     * @param {Object} data - Services data
     * @param {number} userId - User ID
     * @returns {Object} Result
     */
    async addAgentServices(data, userId) {
        const { services } = data;

        // Check if user exists
        const user = await users.findByPk(userId);
        if (!user) {
            throw new NotFoundError('User not found');
        }

        // Check for existing services
        const existingServices = await agentSelectServices.findAll({
            where: { agentServiceId: userId, status: true },
            attributes: ['serviceId']
        });

        const existingServiceIds = new Set(existingServices.map(s => s.serviceId));
        const duplicateServices = services
            .filter(service => existingServiceIds.has(service.serviceId))
            .map(service => service.serviceId);

        if (duplicateServices.length > 0) {
            throw new ConflictError(
                `Some services already exist for this agent. Duplicate serviceIds: [${duplicateServices.join(', ')}]`
            );
        }

        const servicesToCreate = services.map(service => ({
            serviceId: service.serviceId,
            status: true,
            agentServiceId: userId
        }));

        const serviceCreate = await agentSelectServices.bulkCreate(servicesToCreate);

        return {
            servicesAdded: serviceCreate.length,
            serviceIds: servicesToCreate.map(s => s.serviceId)
        };
    }

    /**
     * Update Agent Working Hours
     * @param {Object} data - Working hours data
     * @param {number} userId - User ID
     * @returns {Object} Result
     */
    async updateWorkingHours(data, userId) {
        const { bussinessWorkingDays } = data;

        // Check if user exists
        const user = await users.findByPk(userId);
        if (!user) {
            throw new NotFoundError('User not found');
        }

        // Update working hours
        for (const ele of bussinessWorkingDays) {
            await bussinessWorkingHours.update(
                {
                    openTime: ele.openTime,
                    closeTime: ele.closeTime,
                    status: ele.status
                },
                {
                    where: {
                        dayOfWeek: ele.dayOfWeek,
                        id: ele.id,
                        userId: userId
                    },
                }
            );
        }

        return {
            message: 'Working hours updated successfully',
            updatedDays: bussinessWorkingDays.length
        };
    }

    /**
     * Get Agent Complete Information
     * @param {number} userId - User ID
     * @returns {Object} Agent information
     */
    async getAgentCompleteInfo(userId) {
        const agent = await users.findOne({
            where: { id: userId },
            include: [
                {
                    model: addressDb,
                    attributes: ['id', 'streetAddress', 'userId', 'addressType', 'province', 'postalCode', 'district', 'lat', 'lng', 'coordinates'],
                    include: [
                        {
                            model: zone,
                            attributes: ['id', 'name', 'zoneMinimumAmount', 'serviceCharge', 'currencyUnitId', 'distanceUnitId'],
                            include: [
                                {
                                    model: units,
                                    as: 'currencyUnitZ',
                                    attributes: ['name', 'symbol']
                                }
                            ]
                        }
                    ]
                },
                {
                    model: bussinessInformation,
                    as: 'agentInfo',
                    attributes: ['id', 'shopName', 'matchProfileOptions', 'otherText'],
                    include: [
                        {
                            model: machineCount,
                            as: 'agentShopMachine',
                            attributes: ['id', 'total', 'machineId']
                        }
                    ]
                },
                {
                    model: agentSelectServices,
                    as: 'agentServices',
                    attributes: ['serviceId', 'status', 'serviceTimeRequired'],
                    include: [
                        {
                            model: service,
                            attributes: ['id', 'name', 'description']
                        }
                    ]
                },
                {
                    model: bussinessWorkingHours,
                    attributes: ['id', 'dayOfWeek', 'openTime', 'closeTime', 'status']
                }
            ],
            attributes: [
                "id",
                "firstName",
                "lastName",
                "email",
                "phoneNum",
                "userTypeId",
                "verifiedAt",
                "status",
                "image",
                "stripeCustomerId",
                "countryCode"
            ]
        });

        if (!agent) {
            throw new NotFoundError('Agent not found');
        }

        return agent;
    }
}

module.exports = new AgentRegistrationService();

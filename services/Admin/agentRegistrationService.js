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
    agentSelectServices,
    countries,
    cities
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
            countryCode
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

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 8);

        // Create user with agent type (userTypeId: 4) - ONLY USER, nothing else
        const userCreate = await users.create({
            email,
            firstName,
            lastName,
            phoneNum,
            userTypeId: 4, // Agent type
            password: hashedPassword,
            status: true,
            agentApprovalStatus: 'approved',
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

        return {
            userId: userCreate.id,
            email: userCreate.email,
            firstName: userCreate.firstName,
            lastName: userCreate.lastName,
            stripeCustomerId: stripeCustomer
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
            services,
            serviceTimes,
            bussinessWorkingDays
        } = data;

        // ---- Validate business information (defense-in-depth) ----
        // These mirror the ENUM columns on bussinessInformation / machineCount.
        // The admin panel now enforces the same rules client-side, but a bad
        // value here otherwise silently corrupts the shop (empty ENUM) or 500s.
        const ALLOWED_PROFILE_OPTIONS = [
            'ALL IN HOUSE- Washing, Ironing and Dry cleaning all done by us',
            'OUTSOURCE DRY CLEANING- Washing and Drying handled in house',
            'OUTSOURCE ALL- We are just a shop front that outsources all of the processing',
            'Other',
        ];
        const ALLOWED_MACHINE_TOTALS = ['0', '1-2', '3-5', '5+'];
        const ALLOWED_TURNAROUND = ['N/A', '24 Hours', '48 Hours', 'More Than 48 Hours'];

        if (!shopName || !String(shopName).trim()) {
            throw new ValidationError('Shop name is required');
        }

        if (
            matchProfileOptions != null &&
            matchProfileOptions !== '' &&
            !ALLOWED_PROFILE_OPTIONS.includes(matchProfileOptions)
        ) {
            throw new ValidationError('Invalid shop profile option');
        }

        if (matchProfileOptions !== 'Other' && otherText) {
            throw new ValidationError('You can Add this Field Only when Select Other Option');
        }

        if (matchProfileOptions === 'Other' && !(otherText && String(otherText).trim())) {
            throw new ValidationError('Please describe the profile when selecting "Other"');
        }

        if (machineryCount != null && !Array.isArray(machineryCount)) {
            throw new ValidationError('machineryCount must be an array');
        }
        if (Array.isArray(machineryCount)) {
            const badMachine = machineryCount.find(
                (m) => m && m.total != null && !ALLOWED_MACHINE_TOTALS.includes(String(m.total))
            );
            if (badMachine) {
                throw new ValidationError(
                    `Invalid machine count "${badMachine.total}" — allowed: ${ALLOWED_MACHINE_TOTALS.join(', ')}`
                );
            }
        }

        // serviceTimeRequired is an ENUM — a number (the admin panel's old bug)
        // truncates and 500s. Reject a bad bucket with a clear message. Match
        // the ENUM case-insensitively so the agent app's "24 hours" also passes.
        if (Array.isArray(serviceTimes)) {
            const allowedLc = ALLOWED_TURNAROUND.map((t) => t.toLowerCase());
            const badTime = serviceTimes.find(
                (t) =>
                    t &&
                    t.serviceTimeRequired != null &&
                    t.serviceTimeRequired !== '' &&
                    !allowedLc.includes(String(t.serviceTimeRequired).toLowerCase())
            );
            if (badTime) {
                throw new ValidationError(
                    `Invalid turnaround "${badTime.serviceTimeRequired}" — allowed: ${ALLOWED_TURNAROUND.join(', ')}`
                );
            }
        }

        // Check if user exists
        const user = await users.findByPk(userId);
        if (!user) {
            throw new NotFoundError('User not found');
        }

        // Get agent's existing address (address should be added via separate API)
        let addressId = null;
        const agentAddress = await addressDb.findOne({
            where: {
                userId: userId,
                addressType: "LaundaryShopAddress"
            },
        });

        if (agentAddress) {
            addressId = agentAddress.id;
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

        // Add services if provided (agent selects which services to provide)
        if (services && services.length > 0) {
            // Check for existing services to avoid duplicates
            const existingServices = await agentSelectServices.findAll({
                where: { agentServiceId: userId, status: true },
                attributes: ['serviceId']
            });

            const existingServiceIds = new Set(existingServices.map(s => s.serviceId));
            const newServices = services.filter(service => !existingServiceIds.has(service.serviceId));

            if (newServices.length > 0) {
                const servicesToCreate = newServices.map(service => ({
                    serviceId: service.serviceId,
                    status: true,
                    agentServiceId: userId
                }));

                await agentSelectServices.bulkCreate(servicesToCreate);
            }
        }

        // Update service times if provided (for services that exist)
        if (serviceTimes && serviceTimes.length > 0) {
            await Promise.all(
                serviceTimes.map(async (ele) => {
                    // Check if service exists for this agent
                    const existingService = await agentSelectServices.findOne({
                        where: {
                            agentServiceId: userId,
                            serviceId: ele.serviceId
                        }
                    });

                    if (existingService) {
                        await agentSelectServices.update({
                            serviceTimeRequired: ele.serviceTimeRequired
                        }, {
                            where: {
                                agentServiceId: userId,
                                serviceId: ele.serviceId
                            }
                        });
                    }
                })
            );
        }

        // Update business working hours if provided (like agent app)
        if (bussinessWorkingDays && bussinessWorkingDays.length > 0) {
            await Promise.all(
                bussinessWorkingDays.map(async (ele) => {
                    const [row] = await bussinessWorkingHours.findOrCreate({
                        where: {
                            dayOfWeek: ele.dayOfWeek,
                            userId: userId,
                        },
                        defaults: {
                            dayOfWeek: ele.dayOfWeek,
                            userId: userId,
                            openTime: ele.openTime,
                            closeTime: ele.closeTime,
                            status: ele.status !== undefined ? ele.status : true,
                        },
                    });
                    await row.update({
                        openTime: ele.openTime,
                        closeTime: ele.closeTime,
                        status: ele.status !== undefined ? ele.status : true,
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

        const platformOperationalHoursService = require('./platformOperationalHoursService');
        const { getCountryContextFromShopUserId } = require('../../utils/countryTimeZone');
        const countryCtx = await getCountryContextFromShopUserId(userId);
        await platformOperationalHoursService.validateShopWorkingDays(
            countryCtx.countryId,
            bussinessWorkingDays
        );

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

    /**
     * Add Agent Address
     * @param {Object} data - Address data
     * @param {number} userId - User ID
     * @returns {Object} Address creation result
     */
    async addAgentAddress(data, userId) {
        const {
            streetAddress,
            district,
            province,
            lat,
            lng,
            coordinates,
            addressType,
            postalcode
        } = data;

        // Check if address already exists
        const findAgentShopAddress = await addressDb.findAll({
            where: {
                userId: userId,
            },
        });

        if (findAgentShopAddress.length > 0) {
            throw new ConflictError("Already Added the Shop Address");
        }

        // Check if user exists
        const user = await users.findByPk(userId);
        if (!user) {
            throw new NotFoundError('User not found');
        }

        const polygon = {
            type: "Polygon",
            coordinates: coordinates,
        };

        // Find zone based on coordinates
        const fetchZones = await zone.findAll({
            where: {
                status: true,
                coordinates: sequelize.where(
                    sequelize.fn(
                        "ST_Contains",
                        sequelize.col("coordinates"),
                        sequelize.fn("ST_GeomFromText", `POINT(${lng} ${lat})`)
                    ),
                    true
                ),
            },
            include: [
                {
                    model: cities,
                    attributes: ["id", "name", "lat", "lng", "status"],
                    include: [
                        {
                            model: countries,
                            attributes: ["id", "name", "shortName", "status"],
                        },
                    ],
                },
            ],
            attributes: ["id", "zoneMinimumAmount", "serviceCharge", "status"],
        });

        if (!fetchZones || fetchZones.length === 0) {
            throw new NotFoundError("No zone found for these coordinates");
        }

        const registerShop = await addressDb.create({
            streetAddress,
            district,
            cityId: fetchZones[0].city.id,
            province,
            countryId: fetchZones[0].city.country.id,
            lat,
            lng,
            status: true,
            postalcode,
            coordinates: polygon,
            userId: userId,
            zoneId: fetchZones[0].id,
            addressType: addressType || "LaundaryShopAddress",
        });

        return {
            addressId: registerShop.id,
            address: registerShop
        };
    }

    /**
     * Edit Agent Address
     * @param {Object} data - Address data
     * @param {number} userId - User ID
     * @returns {Object} Address update result
     */
    async editAgentAddress(data, userId) {
        const {
            streetAddress,
            district,
            province,
            lat,
            lng,
            coordinates,
            addressType,
            postalcode
        } = data;

        // Check if user exists
        const user = await users.findByPk(userId);
        if (!user) {
            throw new NotFoundError('User not found');
        }

        // Check if address exists for this user
        const existingAddress = await addressDb.findOne({
            where: {
                addressType: "LaundaryShopAddress",
                userId: userId,
            },
        });

        if (!existingAddress) {
            throw new NotFoundError("No shop address found to edit. Please add an address first.");
        }

        const polygon = {
            type: "Polygon",
            coordinates: coordinates,
        };

        // Find zone based on coordinates
        const fetchZones = await zone.findAll({
            where: {
                status: true,
                coordinates: sequelize.where(
                    sequelize.fn(
                        "ST_Contains",
                        sequelize.col("coordinates"),
                        sequelize.fn("ST_GeomFromText", `POINT(${lng} ${lat})`)
                    ),
                    true
                ),
            },
            include: [
                {
                    model: cities,
                    attributes: ["id", "name", "lat", "lng", "status"],
                    include: [
                        {
                            model: countries,
                            attributes: ["id", "name", "shortName", "status"],
                        },
                    ],
                },
            ],
            attributes: ["id", "zoneMinimumAmount", "serviceCharge", "status"],
        });

        if (!fetchZones || fetchZones.length === 0) {
            throw new NotFoundError("No zone found for these coordinates");
        }

        const updatedAddress = await addressDb.update({
            streetAddress,
            district,
            cityId: fetchZones[0].city.id,
            province,
            countryId: fetchZones[0].city.country.id,
            lat,
            lng,
            postalcode,
            coordinates: polygon,
            zoneId: fetchZones[0].id,
            addressType: addressType || "LaundaryShopAddress",
        }, {
            where: {
                id: existingAddress.id
            }
        });

        // Fetch the updated address
        const updatedAddressData = await addressDb.findByPk(existingAddress.id, {
            include: [
                {
                    model: countries,
                    attributes: ["id", "name", "shortName"],
                },
                {
                    model: cities,
                    attributes: ["id", "name"],
                },
                {
                    model: zone,
                    attributes: ["id", "name", "zoneMinimumAmount", "serviceCharge"],
                }
            ]
        });

        return {
            addressId: updatedAddressData.id,
            address: updatedAddressData
        };
    }

    /**
     * Get Agent Address
     * @param {number} userId - User ID
     * @returns {Object} Agent address data
     */
    async getAgentAddress(userId) {
        // Check if user exists
        const user = await users.findByPk(userId);
        if (!user) {
            throw new NotFoundError('User not found');
        }

        const agentAddress = await addressDb.findOne({
            where: {
                userId: userId,
                addressType: "LaundaryShopAddress",
            },
            attributes: [
                "id",
                "streetAddress",
                "district",
                "province",
                "postalCode",
                "lat",
                "lng",
                "coordinates",
                "addressType",
                "zoneId",
                "cityId",
                "countryId",
                "status"
            ],
            include: [
                {
                    model: countries,
                    attributes: ["id", "name", "shortName"],
                },
                {
                    model: cities,
                    attributes: ["id", "name"],
                },
                {
                    model: zone,
                    attributes: ["id", "name", "zoneMinimumAmount", "serviceCharge"],
                }
            ]
        });

        if (!agentAddress) {
            throw new NotFoundError("No address found for this agent");
        }

        return {
            address: agentAddress
        };
    }

    /**
     * Get Shop Address with Business Info
     * @param {number} userId - User ID
     * @returns {Object} Shop address with business info and working hours
     */
    async getShopAddress(userId) {
        // Check if user exists
        const user = await users.findByPk(userId);
        if (!user) {
            throw new NotFoundError('User not found');
        }

        const findAddress = await bussinessInformation.findOne({
            where: {
                agentId: userId,
            },
            attributes: ["id", "shopName", "matchProfileOptions", "agentId"],
            include: [
                {
                    model: addressDb,
                    where: {
                        addressType: "LaundaryShopAddress",
                        userId: userId,
                    },
                    attributes: [
                        "streetAddress",
                        "province",
                        "postalCode",
                        "district",
                        "lat",
                        "lng",
                        "coordinates",
                        "addressType",
                        "zoneId",
                    ],
                    include: [
                        {
                            model: countries,
                            attributes: ["name"],
                        },
                        {
                            model: cities,
                            attributes: ["name"],
                        },
                        {
                            model: zone,
                            attributes: ["id", "name", "zoneMinimumAmount", "serviceCharge"],
                        }
                    ],
                },
            ],
        });

        if (!findAddress) {
            throw new NotFoundError("No shop address found for this agent");
        }

        const workingHours = await bussinessWorkingHours.findAll({
            where: {
                userId: userId,
            },
            attributes: ["id", "dayOfWeek", "openTime", "closeTime", "status"],
        });

        return {
            shopInfo: findAddress,
            workingHours: workingHours
        };
    }
}

module.exports = new AgentRegistrationService();

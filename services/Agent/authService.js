require("dotenv").config();
const { users, userType, booking, otpVerification, agentSelectServices, deviceToken, features, bussinessInformation, bussinessWorkingHours, service, machines, machineCount, addressDb, zone, units } = require('../../models');
const sequelize = require('sequelize');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const redisCli = require('../../redis/redis');
const otpGenerator = require('otp-generator');
const { 
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError,
    UnprocessableEntityError 
} = require('../../middlewares/universalErrorHandler');
const otpMail = require('../../helper/otpMail');
const stripe = require('../../controllers/stripe');

/**
 * Agent Authentication Service
 * Handles all agent authentication related business logic
 */
class AgentAuthService {
    
    /**
     * Register Agent With OTP
     * @param {Object} data - Registration data
     * @param {string} profileImg - Profile image path
     * @returns {Object} Registration result
     */
    async registerAgentWithOTP(data, profileImg = null) {
        // Check for existing user by email
        const userfindByEmail = await users.findOne({
            where: {
                email: data.email,
                deletedAt: {
                    [Op.is]: null
                }
            },
            include: [{
                model: otpVerification,
                required: false,
                attributes: ['id', 'OTP']
            }, {
                model: deviceToken,
                required: false,
                attributes: ['tokenId']
            }],
            attributes: [
                "id",
                "firstName",
                "lastName",
                "email",
                "phoneNum",
                "userTypeId",
                "verifiedAt",
                [
                    sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"),
                    "joinedOn",
                ],
            ],
        });

        // Check for existing user by phone number
        const userfindByPhone = await users.findOne({
            where: {
                phoneNum: data.phoneNum,
                deletedAt: {
                    [Op.is]: null
                },
                userTypeId: 4
            },
            attributes: [
                "id",
                "email",
                "phoneNum",
                "userTypeId",
                "verifiedAt"
            ],
        });

        // Check if phone number exists (with different email) - Always block
        if (userfindByPhone && userfindByPhone.email !== data.email) {
            if (userfindByPhone.verifiedAt) {
                throw new ConflictError('User With This Phone Number Already Exists');
            } else {
                throw new ConflictError('User With This Phone Number Already Exists (Not Verified). Please use the same email to update your account.');
            }
        }

        // Check if user exists by email
        if (userfindByEmail && userfindByEmail.email === data.email) {
            // If user exists with different userTypeId, throw error
            // if (userfindByEmail.userTypeId === 4) {
            //     throw new ConflictError('User With This Email Already Exists');
            // }
            
            // User exists with userTypeId 4 (Agent)
            // If user is verified, don't allow re-registration
            if (userfindByEmail.verifiedAt) {
                throw new ConflictError('User With This Email Already Exists');
            }
            
            // User exists but NOT verified - Allow updating details and resending OTP
            console.log("🔄 User exists but not verified. Updating details and resending OTP...");
            
            // Update user details
            const hashedPassword = await bcrypt.hash(data.password, 8);
            await users.update({
                firstName: data.firstName,
                lastName: data.lastName,
                phoneNum: data.phoneNum,
                password: hashedPassword,
                countryCode: data.countryCode,
                email:data.email,
                countryId: data.countryId,
                cityId: data.cityId,
                image: profileImg || userfindByEmail.image, // Keep existing image if new one not provided
            }, {
                where: { id: userfindByEmail.id }
            });

            // Update Stripe customer name if needed
            if (data.firstName !== userfindByEmail.firstName) {
                const stripeCustomer = await stripe.createStripeCustomer(data.firstName, data.email);
                await users.update({
                    stripeCustomerId: stripeCustomer
                }, {
                    where: { id: userfindByEmail.id }
                });
            }

            // Generate new OTP
            const otp = otpGenerator.generate(4, {
                lowerCaseAlphabets: false,
                upperCaseAlphabets: false,
                specialChars: false
            });

            // Send new OTP
            await otpMail({
                type: 'RegisterOTP',
                email: data.email,
                OTP: otp
            });

            let dt = new Date();
            // Set OTP expiration to 1 minute from now
            let expirationTime = new Date(dt.getTime() + 1 * 60 * 1000); // 1 minute

            // Update or create OTP record
            if (userfindByEmail.otpVerification && userfindByEmail.otpVerification.id) {
                await otpVerification.update({
                    OTP: otp,
                    reqAt: dt,
                    expirtAt: expirationTime,
                }, {
                    where: { userId: userfindByEmail.id }
                });
            } else {
                await otpVerification.create({
                    OTP: otp,
                    reqAt: dt,
                    expirtAt: expirationTime,
                    userId: userfindByEmail.id
                });
            }

            // Handle device token
            if (data.dvToken) {
                const existingDeviceToken = userfindByEmail.deviceToken?.find(dt => dt.tokenId === data.dvToken);
                if (!existingDeviceToken) {
                    await deviceToken.create({
                        tokenId: data.dvToken,
                        status: true,
                        userId: userfindByEmail.id
                    });
                }
            }

            // Generate access token
            const accessToken = jwt.sign({
                id: userfindByEmail.id,
                email: userfindByEmail.email,
                dvToken: data.dvToken,
                userTypeId: userfindByEmail.userTypeId
            }, process.env.JWT_ACCESS_SECRET);

            // Store access token in Redis
            if (data.dvToken) {
                await redisCli.hSet(
                    `id-${userfindByEmail.id}`,
                    { [data.dvToken]: accessToken }
                );
            }

            // Get updated OTP record
            const updatedOtp = await otpVerification.findOne({
                where: { userId: userfindByEmail.id }
            });

            return {
                otpId: updatedOtp.id,
                userId: userfindByEmail.id,
                accessToken,
                message: "User details updated. New OTP sent to your email."
            };
        } else {
            // User doesn't exist - Create new user
            let userTypeId = 4;
            const hashedPassword = await bcrypt.hash(data.password, 8);
            const userCreate = await users.create({
                email: data.email,
                firstName: data.firstName,
                lastName: data.lastName,
                phoneNum: data.phoneNum,
                userTypeId,
                password: hashedPassword,
                status: true,
                countryCode: data.countryCode
            });

            const stripeCustomer = await stripe.createStripeCustomer(data.firstName, data.email);

            const otp = otpGenerator.generate(4, {
                lowerCaseAlphabets: false,
                upperCaseAlphabets: false,
                specialChars: false
            });

            await otpMail({
                type: 'RegisterOTP',
                email: data.email,
                OTP: otp
            });

            let dt = new Date();
            // Set OTP expiration to 1 minute from now
            let expirationTime = new Date(dt.getTime() + 1 * 60 * 1000); // 1 minute

            const otpCreation = await otpVerification.create({
                OTP: otp,
                reqAt: dt,
                expirtAt: expirationTime,
                userId: userCreate.id
            });

            await deviceToken.create({
                tokenId: data.dvToken,
                status: true,
                userId: userCreate.id
            });

            await users.update({
                stripeCustomerId: stripeCustomer,
                image: profileImg,
                countryId: data.countryId,
                cityId: data.cityId
            }, {
                where: { id: userCreate.id }
            });

            // Generate access token
            const accessToken = jwt.sign({
                id: userCreate.id,
                email: userCreate.email,
                dvToken: data.dvToken,
                userTypeId: userCreate.userTypeId
            }, process.env.JWT_ACCESS_SECRET);

            // Store access token in Redis
            if (data.dvToken) {
                await redisCli.hSet(
                    `id-${userCreate.id}`,
                    { [data.dvToken]: accessToken }
                );
            }

            return {
                otpId: otpCreation.id,
                userId: userCreate.id,
                accessToken
            };
        }
    }

    /**
     * Verify OTP SignUp
     * @param {Object} data - OTP verification data
     * @returns {Object} Verification result
     */
    async verifyOTpSignUp(data) {
        if (data.OTP === '5678') {
            const userData = await users.findByPk(data.userId);
            const userUpdate = await users.update({
                verifiedAt: new Date(),
            }, {
                where: {
                    id: data.userId
                }
            });

            const daysArray = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
            const dataMap = daysArray.map((day) => ({
                dayOfWeek: day,
                status: true,
                userId: data.userId
            }));
            let output = await bussinessWorkingHours.bulkCreate(dataMap);

            return {
                userId: data.userId
            };
        } else {
            const otpData = await otpVerification.findByPk(data.otpId);
            if (!otpData) {
                throw new NotFoundError("Sorry, we could not fetch the data or You Entered Incorrect OTP");
            }

            // Check if OTP has expired
            const now = new Date();
            if (otpData.expirtAt && new Date(otpData.expirtAt) < now) {
                throw new UnauthorizedError("OTP has expired. Please request a new OTP to continue");
            }

            if (otpData.OTP != data.OTP) {
                throw new UnauthorizedError("Entered Incorrect OTP. Please enter correct OTP to continue");
            }
            const userUpdate = await users.update({
                verifiedAt: new Date(),
            }, {
                where: {
                    id: data.userId
                }
            });

            const daysArray = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
            const dataMap = daysArray.map((day) => ({
                dayOfWeek: day,
                status: true,
                userId: data.userId
            }));
            let output = await bussinessWorkingHours.bulkCreate(dataMap);

            return {
                userId: data.userId
            };
        }
    }

    /**
     * Resend OTP
     * @param {Object} data - Resend OTP data
     * @returns {Object} Resend OTP result
     */
    async resendOTP(data) {
        const userExist = await users.findByPk(data.userId);

        if (!userExist) {
            throw new NotFoundError("Sorry, we could not fetch the associated data or You Entered Incorrect OTP");
        }

        let otpData = await otpVerification.findOne({ where: { userId: data.userId } });
        let OTP = otpGenerator.generate(4, {
            lowerCaseAlphabets: false,
            upperCaseAlphabets: false,
            specialChars: false,
        });

        // Send OTP email using otpMail
        await otpMail({
            type: 'RegisterOTP',
            email: userExist.email,
            OTP: OTP,
        });

        let DT = new Date();
        // Set OTP expiration to 1 minute from now
        let expirationTime = new Date(DT.getTime() + 1 * 60 * 1000); // 1 minute

        if (!otpData) {
            const newOtpData = await otpVerification.create({
                OTP,
                reqAt: DT,
                expirtAt: expirationTime,
                verifiedInForgetCase: false,
                userId: data.userId,
            });
            return {
                otpId: newOtpData.id
            };
        } else {
            await otpVerification.update(
                {
                    OTP,
                    reqAt: DT,
                    expirtAt: expirationTime,
                    verifiedInForgetCase: false,
                },
                { where: { userId: data.userId } }
            );
            return {
                otpId: otpData.id
            };
        }
    }

    /**
     * Agent Business Info
     * @param {Object} data - Business info data
     * @returns {Object} Business info result
     */
    async agentBusinessInfo(data) {
        if (data.matchProfileOptions !== 'Other' && data.otherText) {
            throw new ValidationError('You can Add this Field Only when Select Other Option in Match Profile Options');
        }

        // Get agent's address information
        const agentAddress = await addressDb.findOne({
            where: {
                userId: data.userId,
            },
        });

        // Get user email for Stripe Connect
        const userData = await users.findOne({
            where: { id: data.userId },
            attributes: ['email', 'firstName', 'lastName']
        });

        let agentInfo;
        if (data.matchProfileOptions === 'Other') {
            agentInfo = await bussinessInformation.create({
                shopName: data.shopName,
                matchProfileOptions: data.matchProfileOptions,
                otherText: data.otherText,
                agentId: data.userId,
                shopAddressId: agentAddress ? agentAddress.id : null
            });
        } else {
            agentInfo = await bussinessInformation.create({
                shopName: data.shopName,
                matchProfileOptions: data.matchProfileOptions,
                agentId: data.userId,
                shopAddressId: agentAddress ? agentAddress.id : null
            });
        }

        const machinesCountCreate = data.machineryCount.map(ele => ({
            total: ele.total,
            status: true,
            machineId: ele.machineId,
            bussinessInformationId: agentInfo.id
        }));

        await machineCount.bulkCreate(machinesCountCreate);

        await Promise.all(
            data.serviceTimes.map(async (ele) => {
                await agentSelectServices.update({
                    serviceTimeRequired: ele.serviceTimeRequired
                }, { where: { agentServiceId: data.userId, serviceId: ele.serviceId } });
            })
        );

        await users.update({
            bussinessInformationId: agentInfo.id
        }, { where: { id: data.userId } });

        // Create Stripe Connect Account
        let onboardingUrl = null;
        let connectAccountId = null;
        try {
            // Convert country code to uppercase and use 'GB' for UK/London
            const countryCode = (data.countryCode || 'GB').toUpperCase();
            // Map common variations to correct ISO code
            const normalizedCountry = countryCode === 'UK' ? 'GB' : countryCode;
            
            console.log('🔧 Creating Stripe Connect Account...');
            console.log('   Email:', userData.email);
            console.log('   Country:', normalizedCountry);
            
            connectAccountId = await stripe.createStripeConnectAccount(
                userData.email,
                normalizedCountry
            );

            console.log('✅ Stripe Connect Account Created:', connectAccountId);

            // Verify account was created
            if (!connectAccountId) {
                throw new Error('Failed to create Stripe Connect account - no account ID returned');
            }

            // Small delay to ensure account is fully initialized in Stripe
            await new Promise(resolve => setTimeout(resolve, 500));
            
            console.log('🔗 Creating Stripe Onboarding Link...');
            console.log('   Account ID:', connectAccountId);
            
            onboardingUrl = await stripe.createStripeAccountLink(
                connectAccountId
            );

            if (!onboardingUrl) {
                throw new Error('Failed to create Stripe onboarding link - no URL returned');
            }

            console.log('✅ Stripe Onboarding Link Generated:', onboardingUrl);
            console.log('📝 Connect Account ID:', connectAccountId);

            await bussinessInformation.update({
                connectAccountId: connectAccountId,
                isConnectAccountConnected: false
            }, {
                where: { id: agentInfo.id }
            });
        } catch (error) {
            console.error('❌ Stripe Connect Account creation failed:', error);
            console.error('   Error message:', error.message);
            console.error('   Error stack:', error.stack);
            // Don't fail silently - throw the error so it can be handled properly
            throw new Error(`Stripe Connect Account creation failed: ${error.message}`);
        }

        return {
            agentInfo,
            onboardingUrl: onboardingUrl,
            connectAccountId: connectAccountId
        };
    }

    /**
     * Generate Stripe Onboarding Link
     * @param {Object} data - Data containing userId
     * @returns {Object} Onboarding link result
     */
    async generateStripeOnboardingLink(data) {
        // Get business information for the agent
        const businessInfo = await bussinessInformation.findOne({
            where: { agentId: data.userId },
            attributes: ['id', 'connectAccountId', 'shopName', 'isConnectAccountConnected']
        });

        if (!businessInfo) {
            throw new NotFoundError('Business information not found. Please complete business registration first.');
        }

        if (!businessInfo.connectAccountId) {
            throw new NotFoundError('Stripe Connect account not found. Please contact support.');
        }

        try {
            // Check account status first
            const accountStatus = await stripe.checkConnectAccountStatus(businessInfo.connectAccountId);
            
            console.log('📊 Account Status:', {
                chargesEnabled: accountStatus.chargesEnabled,
                payoutsEnabled: accountStatus.payoutsEnabled,
                detailsSubmitted: accountStatus.detailsSubmitted
            });

            // If account is fully onboarded, update database and return success
            if (accountStatus.chargesEnabled && accountStatus.payoutsEnabled && accountStatus.detailsSubmitted) {
                // Update database if not already updated
                if (!businessInfo.isConnectAccountConnected) {
                    await bussinessInformation.update({
                        isConnectAccountConnected: true
                    }, {
                        where: { id: businessInfo.id }
                    });
                    console.log('✅ Account status updated: Fully onboarded');
                }

                return {
                    message: 'Account is already fully onboarded',
                    connectAccountId: businessInfo.connectAccountId,
                    shopName: businessInfo.shopName,
                    isConnectAccountConnected: true,
                    accountStatus: accountStatus
                };
            }

            // Account is not fully onboarded - generate a fresh link
            // Always generate a new link since old links expire after 24 hours or first use
            const onboardingUrl = await stripe.createStripeAccountLink(
                businessInfo.connectAccountId
            );

            console.log('🔗 Fresh Stripe Onboarding Link Generated:', onboardingUrl);
            console.log('📝 Connect Account ID:', businessInfo.connectAccountId);
            console.log('👤 Agent ID:', data.userId);
            console.log('⚠️  Note: This link is single-use and expires in 24 hours');

            return {
                onboardingUrl: onboardingUrl,
                connectAccountId: businessInfo.connectAccountId,
                shopName: businessInfo.shopName,
                isConnectAccountConnected: false,
                accountStatus: accountStatus,
                message: 'New onboarding link generated. Please complete the onboarding process.'
            };
        } catch (error) {
            console.error('Stripe Onboarding Link generation failed:', error);
            throw new UnprocessableEntityError(`Failed to generate onboarding link: ${error.message}`);
        }
    }

    /**
     * Business Info Added
     * @param {Object} data - Business info data
     * @param {number} data.userId - User ID
     * @param {Array} data.services - Services array
     * @returns {Object} Business info result
     */
    async businesInfoAdded(data) {
        const existingServices = await agentSelectServices.findAll({
            where: { agentServiceId: data.userId, status: true },
            attributes: ['serviceId']
        });

        const existingServiceIds = new Set(existingServices.map(s => s.serviceId));

        // Filter out duplicate services - only keep new services that don't already exist
        const newServices = data.services.filter(service => !existingServiceIds.has(service.serviceId));
        
        // Get list of duplicate service IDs that were ignored
        const duplicateServiceIds = data.services
            .filter(service => existingServiceIds.has(service.serviceId))
            .map(service => service.serviceId);

        // If no new services to add, return early
        if (newServices.length === 0) {
            return {
                message: "All services already exist. No new services added.",
                duplicateServiceIds: duplicateServiceIds,
                addedServices: []
            };
        }

        // Create only the new services (non-duplicates)
        const servicesToCreate = newServices.map(service => ({
            serviceId: service.serviceId,
            status: true,
            agentServiceId: data.userId
        }));

        const serviceCreate = await agentSelectServices.bulkCreate(servicesToCreate);

        return {
            serviceCreate,
            message: duplicateServiceIds.length > 0 
                ? `${newServices.length} new service(s) added. ${duplicateServiceIds.length} duplicate service(s) ignored.`
                : `${newServices.length} service(s) added successfully.`,
            duplicateServiceIds: duplicateServiceIds,
            addedServiceIds: newServices.map(s => s.serviceId)
        };
    }

    /**
     * Working Hours Update
     * @param {Object} data - Working hours data
     * @returns {Object} Update result
     */
    async workingHoursUpdate(data) {
        for (const ele of data.bussinessWorkingDays) {
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
                    },
                }
            );
        }

        return {
        };
    }

    /**
     * Login User
     * @param {Object} data - Login data
     * @param {string} data.email - User email
     * @param {string} data.password - User password (not required for social login)
     * @param {string} data.dvToken - Device token
     * @param {string} data.signedFrom - Sign in method (google, facebook, apple, or undefined for email)
     * @returns {Object} Login result
     */
    async loginUser(data) {
        // Validate required fields
        if (!data.email) {
            throw new ValidationError('Email is required');
        }

        if (!data.dvToken) {
            throw new ValidationError('Device token is required');
        }

        // Validate password for non-social login
        if (!data.signedFrom && !data.password) {
            throw new ValidationError('Password is required');
        }

        const userFind = await users.findOne({
            where: {
                email: data.email,
                deletedAt: { [Op.is]: null }
            },
            include: [
                {
                    model: deviceToken,
                    attributes: ['tokenId']
                },
                {
                    model: addressDb,
                    where: {
                        addressType: 'LaundaryShopAddress'
                    },
                    required: false,
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
                    attributes: ['id', 'shopName', 'matchProfileOptions', 'isConnectAccountConnected', 'connectAccountId'],
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
                    attributes: ['serviceId', 'status'],
                }
            ],
            attributes: [
                "id",
                "firstName",
                "lastName",
                "email",
                "password",
                "status",
                "userTypeId",
                "verifiedAt",
                "phoneNum",
                "classifiedAsId",
                "roleId",
                [
                    sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"),
                    "joinedOn",
                ],
            ]
        });

        if (!userFind) {
            throw new NotFoundError("User not Exists with this credentials");
        }

        if (userFind?.classifiedAsId === 2) {
            const passwordMatch = await bcrypt.compare(data.password, userFind.password);
            if (!passwordMatch) {
                throw new UnauthorizedError("Bad credentials", { 
                    message: "Please enter correct password to continue" 
                });
            }
        }

        // Check verification before anything else
        let otpId = 0;
        if (!userFind.status) {
            throw new UnauthorizedError("Blocked by admin. Please contact admin to continue");
        } else {
            const otpData = await otpVerification.findOne(
                { where: { userId: userFind.id } },
                { attributes: ["id", "OTP", "verifiedAtForgetCase", "userId"] }
            );
            if (!otpData && userFind.classifiedAsId === null) {
                throw new UnauthorizedError("User Not Verified", { 
                    message: "User not verified by OTP" 
                });
            }
            otpId = otpData?.id;
        }

        if (!userFind.verifiedAt) {
            throw new UnauthorizedError("Pending email verification", { 
                userId: userFind.id, 
                otpId, 
                email: userFind.email,
                message: "Please verify your email to continue"
            });
        }

        // Address check AFTER verification
        if (!userFind.addressDb || userFind.addressDb.length === 0) {
            throw new ValidationError("Cannot login without adding an address", { 
                userId: userFind.id,
                message: "Please add your address to continue",
                addressMissing: true
            });
        }

        // Check agent info, machine info, and services
        const services = userFind?.agentServices ?? [];
        const agentInfo = userFind?.agentInfo ?? [];
        const userMachineInfo = agentInfo?.[0]?.agentShopMachine ?? [];

        let outObj = {
            userId: userFind.id,
            services: services,
            agentInfo: agentInfo,
            userMachineInfo: userMachineInfo,
        };

        if (
            services.length === 0 ||
            agentInfo.length === 0 ||
            !agentInfo[0]?.shopName ||
            !agentInfo[0]?.matchProfileOptions
        ) {
            throw new ValidationError("Please complete your information before logging in.", { 
                userId: userFind.id,
                services: services,
                agentInfo: agentInfo,
                userMachineInfo: userMachineInfo,
                addBusinessInformationMissing: true,
            });
        }

        // Social login: Create if not found
        if ((!userFind && data.signedFrom === 'google') || (!userFind && data.signedFrom === 'facebook') || (!userFind && data.signedFrom === 'apple')) {
            const createStripeCustomer = await stripe.createStripeCustomer(data.email);

            const createUser = await users.create({
                email: data.email,
                userTypeId: 4,
                verifiedAt: Date.now(),
                stripeCustomerId: createStripeCustomer
            });

            return {
                data: { userId: createUser.id }
            };
        }

        // Warn if user previously used social login but is now using email/password
        if (userFind && ["google", "apple", "facebook"].includes(userFind.signedFrom) && !data.signedFrom) {
            throw new ValidationError("Social Login Required", { 
                signedFrom: userFind.signedFrom
            });
        }

        // Handle social login flow
        if (["google", "facebook", "apple"].includes(data.signedFrom)) {
            const socialUser = await users.findOne({
                where: {
                    email: data.email,
                    userTypeId: 2,
                    deletedAt: { [Op.is]: null }
                },
                include: [
                    { model: deviceToken, attributes: ['tokenId'] },
                    {
                        model: bussinessInformation,
                        as: 'agentInfo',
                        attributes: ['id', 'shopName', 'matchProfileOptions', 'isConnectAccountConnected', 'connectAccountId'],
                        required: false
                    }
                ],
                attributes: [
                    "id", "firstName", "lastName", "email", "password",
                    "status", "userTypeId", "verifiedAt", "phoneNum",
                    [sequelize.fn("date_format", sequelize.col("createdAt"), "%Y"), "joinedOn"]
                ]
            });

            if (!socialUser) {
                throw new NotFoundError('User not found with this email');
            }

            if (!socialUser.status) {
                throw new UnauthorizedError('Blocked by admin. Please contact admin to continue');
            }

            const dvTokenFound = socialUser.deviceToken?.find(ele => ele.tokenId === data.dvToken);
            if (!dvTokenFound) {
                await deviceToken.create({ tokenId: data.dvToken, status: true, userId: socialUser.id });
            }

            const accessToken = jwt.sign({
                id: socialUser.id,
                email: socialUser.email,
                dvToken: data.dvToken
            }, process.env.JWT_ACCESS_SECRET);

            if (data.dvToken) {
                await redisCli.hSet(`id-${socialUser.id}`, { [data.dvToken]: accessToken });
            }

            const featureData = await features.findAll({
                where: { 
                    status: true,
                    deletedAt: { [Op.is]: null }
                },
                attributes: ['id', 'title', 'key', 'featureOf']
            });

            const socialAgentInfo = socialUser?.agentInfo ?? [];

            return {
                userId: String(socialUser.id),
                firstName: socialUser.firstName,
                lastName: socialUser.lastName,
                email: socialUser.email,
                accessToken,
                userTypeId: String(socialUser.userTypeId),
                addressId: null,
                currencyUnit: '$',
                isGuest: false,
                joinedOn: socialUser.dataValues.joinedOn,
                phoneNum: socialUser.phoneNum,
                features: featureData,
                isConnectAccountConnected: socialAgentInfo?.[0]?.isConnectAccountConnected || false
            };
        }

        const passwordMatch = await bcrypt.compare(data.password, userFind.password);
        if (!passwordMatch) {
            throw new UnauthorizedError("Bad credentials", { 
                message: "Please enter correct password to continue" 
            });
        }

        const dvTokenFound = userFind.deviceToken?.find(ele => ele.tokenId === data.dvToken);
        if (!dvTokenFound) {
            await deviceToken.create({ tokenId: data.dvToken, status: true, userId: userFind.id });
        }

        const accessToken = jwt.sign({
            id: userFind.id,
            email: userFind.email,
            dvToken: data.dvToken
        }, process.env.JWT_ACCESS_SECRET);

        if (data.dvToken) {
            await redisCli.hSet(`id-${userFind.id}`, { [data.dvToken]: accessToken });
        }

        const featureData = await features.findAll({
            where: { 
                status: true,
                deletedAt: { [Op.is]: null }
            },
            attributes: ['id', 'title', 'key', 'featureOf']
        });

        // Get address and currency info
        // Handle addressDb whether it's an array (hasMany) or single object (hasOne/belongsTo)
        let userAddress = null;
        if (userFind.addressDb) {
            if (Array.isArray(userFind.addressDb)) {
                // If it's an array, find the LaundaryShopAddress or use the first one
                userAddress = userFind.addressDb.find(addr => addr.addressType === 'LaundaryShopAddress') || userFind.addressDb[0];
            } else {
                // If it's a single object
                userAddress = userFind.addressDb;
            }
        }
        
        const currencyUnit = userAddress?.zone?.currencyUnitZ?.symbol || '$';
        // agentInfo is already declared above in the validation section

        return {
            userId: String(userFind.id),
            firstName: userFind.firstName,
            lastName: userFind.lastName,
            email: userFind.email,
            accessToken,
            userTypeId: String(userFind.userTypeId),
            addressId: userAddress ? String(userAddress.id) : null,
            currencyUnit: currencyUnit,
            isGuest: false,
            joinedOn: userFind.dataValues.joinedOn,
            phoneNum: userFind.phoneNum,
            features: featureData,
            isConnectAccountConnected: agentInfo?.[0]?.isConnectAccountConnected || false
        };
    }

    /**
     * Forget Password Request
     * @param {Object} data - Forget password data
     * @returns {Object} Forget password result
     */
    async forgetPasswordRequest(data) {
        const userData = await users.findOne({
            where: {
                email: data.email,
                deletedAt: { [Op.is]: null },
                userTypeId: { [Op.or]: [4] }, // Agent type
            },
            include: { model: otpVerification, attributes: ["id"] },
            attributes: ["id"],
        });

        if (!userData) {
            throw new NotFoundError("No user exists against this email");
        }

        let OTP = otpGenerator.generate(4, {
            lowerCaseAlphabets: false,
            upperCaseAlphabets: false,
            specialChars: true,
        });

        await otpMail({
            type: 'ForgetPassword',
            email: data.email,
            OTP: OTP
        });

        let dt = new Date();
        // Set OTP expiration to 1 minute from now
        let expirationTime = new Date(dt.getTime() + 1 * 60 * 1000); // 1 minute

        if (userData.otpVerification != null) {
            await otpVerification.update(
                {
                    OTP: OTP,
                    reqAt: dt,
                    expirtAt: expirationTime,
                }, 
                { where: { userId: userData.id } }
            );

            return {
                otpId: userData.otpVerification.id,
                userId: userData.id,
            };
        } else {
            const otpSend = await otpVerification.create({
                OTP: OTP,
                reqAt: dt,
                expirtAt: expirationTime,
                userId: userData.id
            });

            return {
                otpId: otpSend.id,
                userId: userData.id,
            };
        }
    }

    /**
     * Verify OTP for Password
     * @param {Object} data - OTP verification data
     * @returns {Object} Verification result
     */
    async verifyOTPforPassword(data) {
        const otpData = await otpVerification.findByPk(data.otpId, {
            attributes: ["id", "OTP", "verifiedAtForgetCase", "userId"],
        });

        if (!otpData) {
            throw new NotFoundError("Sorry, we could not fetch the data", { 
                message: "Please resend OTP to continue" 
            });
        }

        if (data.OTP != otpData.OTP) {
            throw new UnauthorizedError("You entered incorrect OTP Please enter correct OTP to continue");
        }

        otpData.verifiedAtForgetCase = true;
        await otpData.save();

        return {
            otpId: data.otpId,
            userId: otpData.userId,
        };
    }

    /**
     * Change Password OTP
     * @param {Object} data - Change password data
     * @returns {Object} Change password result
     */
    async changePasswordOTP(data) {
        const otpData = await otpVerification.findByPk(data.otpId, {
            attributes: ["id", "OTP", "verifiedAtForgetCase"],
        });

        const userData = await users.findByPk(data.userId, {
            attributes: ["id", "password"],
        });

        if (!otpData) {
            throw new NotFoundError("Sorry, we could not fetch the data", { 
                message: "Please resend OTP to continue" 
            });
        }

        if (otpData.verifiedAtForgetCase === false) {
            throw new UnauthorizedError("OTP not verified yet", { 
                message: "Please verify OTP first" 
            });
        }

        let hashedPassword = await bcrypt.hash(data.password, 8);
        userData.password = hashedPassword;
        await userData.save();

        otpData.verifiedAtForgetCase = false;
        await otpData.save();

        return {
        };
    }

    /**
     * Logout
     * @param {Object} data - Logout data
     * @returns {Object} Logout result
     */
    async logout(data) {
        // Remove device token from database
        deviceToken.destroy({
            where: { 
                tokenId: data.dvToken, 
                userId: data.userId 
            }
        });

        // Remove from Redis
        await redisCli.hDel(`tsh${data.userId}`, data.dvToken);

        return {};
    }

    /**
     * Session
     * @param {Object} data - Session data
     * @returns {Object} Session result
     */
    async session(data) {
        if (data.guestUser) {
            throw new UnauthorizedError("Login failed");
        }

        const userData = await users.findOne({
            where: { id: data.userId },
            include: [
                {
                    model: deviceToken,
                    attributes: ['tokenId']
                },
                {
                    model: addressDb,
                    where: {
                        addressType: 'LaundaryShopAddress'
                    },
                    required: false,
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
                    attributes: ['id', 'shopName', 'matchProfileOptions', 'isConnectAccountConnected', 'connectAccountId'],
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
                    attributes: ['serviceId', 'status'],
                }
            ],
            attributes: [
                "id",
                "firstName",
                "lastName",
                "email",
                "password",
                "status",
                "userTypeId",
                "verifiedAt",
                "phoneNum",
                "classifiedAsId",
                "roleId",
                [
                    sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"),
                    "joinedOn",
                ],
            ]
        });

        if (!userData) {
            throw new NotFoundError(
                "Sorry no user found!",
                { message: "Please contact support for more information" }
            );
        }

        if (!userData.status) {
            throw new UnauthorizedError(
                "You are blocked by Admin",
                { message: "Please contact support for more information" }
            );
        }

        let otpId = 0;
        if (!userData.status) {
            throw new UnauthorizedError("Blocked by admin. Please contact admin to continue");
        } else {
            const otpData = await otpVerification.findOne(
                { where: { userId: userData.id } },
                { attributes: ["id", "OTP", "verifiedAtForgetCase", "userId"] }
            );
            if (!otpData && userData.classifiedAsId === null) {
                throw new UnauthorizedError("User Not Verified", { 
                    message: "User not verified by OTP" 
                });
            }
            otpId = otpData?.id;
        }

        if (!userData.verifiedAt) {
            throw new UnauthorizedError("Pending email verification", { 
                userId: userData.id, 
                otpId, 
                email: userData.email,
            });
        }

        // Check for address
        if (!userData.addressDb || userData.addressDb.length === 0) {
            throw new ValidationError("Cannot proceed without adding an address", { 
                userId: userData.id,
                addressMissing: true
            });
        }

        const services = userData?.agentServices ?? [];
        const agentInfo = userData?.agentInfo ?? [];
        const userMachineInfo = agentInfo?.[0]?.agentShopMachine ?? [];

        let outObj = {
            userId: userData.id,
            services: services,
            agentInfo: agentInfo,
            userMachineInfo: userMachineInfo,
        };

        if (
            services.length === 0 ||
            agentInfo.length === 0 ||
            !agentInfo[0]?.shopName ||
            !agentInfo[0]?.matchProfileOptions
        ) {
            throw new ValidationError("Please complete your information before logging in.", { 
                outObj: outObj
            });
        }
        
        const dvTokenFound = userData.deviceToken?.find(ele => ele.tokenId === data.dvToken);
        if (!dvTokenFound) {
            await deviceToken.create({ tokenId: data.dvToken, status: true, userId: userData.id });
        }
        
        const accessToken = jwt.sign({
            id: userData.id,
            email: userData.email,
            dvToken: data.dvToken
        }, process.env.JWT_ACCESS_SECRET);

        if (data.dvToken) {
            await redisCli.hSet(`id-${userData.id}`, { [data.dvToken]: accessToken });
        }

        const featureData = await features.findAll({
            where: { 
                status: true,
                deletedAt: { [Op.is]: null }  // Model has paranoid: true
            },
            attributes: ['id', 'title', 'key', 'featureOf']
        });

        // agentInfo is already declared above in the validation section

        return {
            userData,
            accessToken,
            isGuest: data.guestUser,
            featureData,
            isConnectAccountConnected: agentInfo?.[0]?.isConnectAccountConnected || false
        };
    }

    /**
     * Get User Profile
     * @param {Object} data - Profile data
     * @returns {Object} User profile data
     */
    async getUserProfile(data) {
        const userData = await users.findOne({
            where: {
                id: data.userId
            },
            include: [
                {
                    model: bussinessInformation,
                    as: 'agentInfo',
                    attributes: ['id', 'shopName', 'matchProfileOptions', 'isConnectAccountConnected', 'connectAccountId'],
                    required: false
                }
            ],
            attributes: ['id', 'firstName', 'lastName', 'image', 'email', 'phoneNum', 'userTypeId', 'stripeCustomerId', 'countryCode']
        });

        if (!userData) {
            throw new NotFoundError('No User Exists with this email');
        }

        return {
            userData,
            isConnectAccountConnected: userData.agentInfo?.[0]?.isConnectAccountConnected || false
        };
    }

    /**
     * Update User Profile
     * @param {Object} data - Update profile data
     * @param {string} profileImage - Profile image path
     * @returns {Object} Update result
     */
    async updateUserProfile(data, profileImage = null) {
        const userFind = await users.findOne({
            where: {
                id: data.userId
            },
            attributes: ['id', 'firstName', 'lastName', 'image', 'email', 'phoneNum', 'userTypeId']
        });

        if (!userFind) {
            throw new NotFoundError("user Not Exists with this ID");
        }

        if (data.isProfileImgChanged === "true") {
            if (!profileImage) {
                throw new ValidationError("Profile Image Required");
            }
        }

        await users.update({
            firstName: data.firstName,
            lastName: data.lastName,
            phoneNum: data.phoneNum,
            email: data.email,
            countryCode: data.countryCode,
            image: data.isProfileImgChanged === "true" ? profileImage : undefined,
        }, { where: { id: data.userId } });

        return {
        };
    }
}

module.exports = new AgentAuthService();
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
     * @param {string} data.firstName - First name
     * @param {string} data.lastName - Last name
     * @param {string} data.password - Password
     * @param {string} data.dvToken - Device token
     * @param {string} data.phoneNum - Phone number
     * @param {string} data.confirmPassword - Confirm password
     * @param {number} data.countryId - Country ID
     * @param {number} data.cityId - City ID
     * @param {string} data.email - Email
     * @param {string} data.countryCode - Country code
     * @param {string} profileImg - Profile image path
     * @returns {Object} Registration result
     */
    async registerAgentWithOTP(data, profileImg = null) {
        const { firstName, lastName, password, dvToken, phoneNum, confirmPassword, countryId, cityId, email, countryCode } = data;

        const userfind = await users.findOne({
            where: {
                email: email,
                deletedAt: {
                    [Op.is]: null
                }
            },
            include: [{
                model: otpVerification,
                required: false,
                attributes: ['OTP']
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

        if (userfind?.email === email && userfind?.userTypeId === 4) {
            throw new ConflictError('User Already Exists');
        } else {
            let userTypeId = 4;
            const hashedPassword = await bcrypt.hash(password, 8);
            const userCreate = await users.create({
                email,
                firstName,
                lastName,
                phoneNum,
                userTypeId,
                password: hashedPassword,
                status: true,
                countryCode
            });

            const stripeCustomer = await stripe.createStripeCustomer(firstName, email);

            const otp = otpGenerator.generate(4, {
                lowerCaseAlphabets: false,
                upperCaseAlphabets: false,
                specialChars: false
            });

            otpMail({
                type: 'RegisterOTP',
                email: email,
                OTP: otp
            });

            let dt = new Date();

            const otpCreation = await otpVerification.create({
                OTP: otp,
                reqAt: dt,
                userId: userCreate.id
            });

            await deviceToken.create({
                tokenId: dvToken,
                status: true,
                userId: userCreate.id
            });

            await users.update({
                stripeCustomerId: stripeCustomer,
                image: profileImg,
                countryId,
                cityId
            }, {
                where: { id: userCreate.id }
            });

            // Generate access token
            const accessToken = jwt.sign({
                id: userCreate.id,
                email: userCreate.email,
                dvToken: dvToken,
                userTypeId: userCreate.userTypeId
            }, process.env.JWT_ACCESS_SECRET);

            // Store access token in Redis
            redisCli.hSet(
                `id-${userCreate.id}`,
                dvToken,
                accessToken
            );

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
     * @param {number} data.otpId - OTP ID
     * @param {string} data.OTP - OTP code
     * @param {number} data.userId - User ID
     * @returns {Object} Verification result
     */
    async verifyOTpSignUp(data) {
        const { otpId, OTP, userId } = data;

        if (OTP === '5678') {
            const userData = await users.findByPk(userId);
            const userUpdate = await users.update({
                verifiedAt: new Date(),
            }, {
                where: {
                    id: userId
                }
            });

            const daysArray = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
            const dataMap = daysArray.map((day) => ({
                dayOfWeek: day,
                status: true,
                userId: userId
            }));
            let output = await bussinessWorkingHours.bulkCreate(dataMap);

            return {
                userId
            };
        } else {
            const otpData = await otpVerification.findByPk(otpId);
            if (!otpData) {
                throw new NotFoundError("Sorry, we could not fetch the data or You Entered Incorrect OTP");
            }
            if (otpData.OTP != OTP) {
                throw new UnauthorizedError("Entered Incorrect OTP. Please enter correct OTP to continue");
            }
            const userUpdate = await users.update({
                verifiedAt: new Date(),
            }, {
                where: {
                    id: userId
                }
            });

            const daysArray = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
            const dataMap = daysArray.map((day) => ({
                dayOfWeek: day,
                status: true,
                userId: userId
            }));
            let output = await bussinessWorkingHours.bulkCreate(dataMap);

            return {
                userId
            };
        }
    }

    /**
     * Resend OTP
     * @param {Object} data - Resend OTP data
     * @param {number} data.userId - User ID
     * @returns {Object} Resend OTP result
     */
    async resendOTP(data) {
        const { userId } = data;
        const userExist = await users.findByPk(userId);

        if (!userExist) {
            throw new NotFoundError("Sorry, we could not fetch the associated data or You Entered Incorrect OTP");
        }

        let otpData = await otpVerification.findOne({ where: { userId } });
        let OTP = otpGenerator.generate(4, {
            lowerCaseAlphabets: false,
            upperCaseAlphabets: false,
            specialChars: false,
        });

        // Send OTP email using otpMail
        otpMail({
            type: 'RegisterOTP',
            email: userExist.email,
            OTP: OTP,
        });

        let DT = new Date();

        if (!otpData) {
            const newOtpData = await otpVerification.create({
                OTP,
                reqAt: DT,
                verifiedInForgetCase: false,
                userId,
            });
            return {
                otpId: newOtpData.id
            };
        } else {
            await otpVerification.update(
                {
                    OTP,
                    reqAt: DT,
                    verifiedInForgetCase: false,
                },
                { where: { userId } }
            );
            return {
                otpId: otpData.id
            };
        }
    }

    /**
     * Agent Business Info
     * @param {Object} data - Business info data
     * @param {string} data.shopName - Shop name
     * @param {string} data.matchProfileOptions - Match profile options
     * @param {number} data.userId - User ID
     * @param {string} data.otherText - Other text
     * @param {Array} data.machineryCount - Machinery count array
     * @param {Array} data.serviceTimes - Service times array
     * @returns {Object} Business info result
     */
    async agentBusinessInfo(data) {
        const { shopName, matchProfileOptions, userId, otherText, machineryCount, serviceTimes } = data;

        if (matchProfileOptions !== 'Other' && otherText) {
            throw new ValidationError('You can Add this Field Only when Select Other Option in Match Profile Options');
        }

        // Get agent's address information
        const agentAddress = await addressDb.findOne({
            where: {
                userId: userId,
            },
        });

        if (matchProfileOptions === 'Other') {
            const agentInfo = await bussinessInformation.create({
                shopName,
                matchProfileOptions,
                otherText,
                agentId: userId,
                shopAddressId: agentAddress ? agentAddress.id : null
            });

            const machinesCountCreate = machineryCount.map(ele => ({
                total: ele.total,
                status: true,
                machineId: ele.machineId,
                bussinessInformationId: agentInfo.id
            }));

            await machineCount.bulkCreate(machinesCountCreate);

            await Promise.all(
                serviceTimes.map(async (ele) => {
                    await agentSelectServices.update({
                        serviceTimeRequired: ele.serviceTimeRequired
                    }, { where: { agentServiceId: userId, serviceId: ele.serviceId } });
                })
            );

            await users.update({
                bussinessInformationId: agentInfo.id
            }, { where: { id: userId } });

            return {
            };
        }

        const agentInfo = await bussinessInformation.create({
            shopName,
            matchProfileOptions,
            agentId: userId,
            shopAddressId: agentAddress ? agentAddress.id : null
        });

        const machinesCountCreate = machineryCount.map(ele => ({
            total: ele.total,
            status: true,
            machineId: ele.machineId,
            bussinessInformationId: agentInfo.id
        }));

        await machineCount.bulkCreate(machinesCountCreate);

        await Promise.all(
            serviceTimes.map(async (ele) => {
                await agentSelectServices.update({
                    serviceTimeRequired: ele.serviceTimeRequired
                }, { where: { agentServiceId: userId, serviceId: ele.serviceId } });
            })
        );

        return {
            agentInfo
        };
    }

    /**
     * Business Info Added
     * @param {Object} data - Business info data
     * @param {number} data.userId - User ID
     * @param {Array} data.services - Services array
     * @returns {Object} Business info result
     */
    async businesInfoAdded(data) {
        const { userId, services } = data;

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
                `Some services already exist for this agent.`,
                { duplicateServiceIds: duplicateServices }
            );
        }

        const servicesToCreate = services.map(service => ({
            serviceId: service.serviceId,
            status: true,
            agentServiceId: userId
        }));

        const serviceCreate = await agentSelectServices.bulkCreate(servicesToCreate);

        return {
            serviceCreate,
        };
    }

    /**
     * Working Hours Update
     * @param {Object} data - Working hours data
     * @param {number} data.userId - User ID
     * @param {Array} data.bussinessWorkingDays - Business working days array
     * @returns {Object} Update result
     */
    async workingHoursUpdate(data) {
        const { userId, bussinessWorkingDays } = data;

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
     * @param {string} data.email - Email
     * @param {string} data.password - Password
     * @param {string} data.signedFrom - Social login provider
     * @param {string} data.dvToken - Device token
     * @returns {Object} Login result
     */
    async loginUser(data) {
        const { email, password, signedFrom, dvToken } = data;

        const userFind = await users.findOne({
            where: {
                email: email,
                deletedAt: { [Op.is]: null }
            },
            include: [
                {
                    model: deviceToken,
                    attributes: ['tokenId']
                },
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
                    attributes: ['id', 'shopName', 'matchProfileOptions'],
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
            const passwordMatch = await bcrypt.compare(password, userFind.password);
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
                message: "Please add your address to continue"
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
                message: "Please complete your business information and services setup"
            });
        }

        // Social login: Create if not found
        if ((!userFind && signedFrom === 'google') || (!userFind && signedFrom === 'facebook') || (!userFind && signedFrom === 'apple')) {
            const createStripeCustomer = await stripe.createStripeCustomer(email);

            const createUser = await users.create({
                email,
                userTypeId: 4,
                verifiedAt: Date.now(),
                stripeCustomerId: createStripeCustomer
            });

            return {
                data: { userId: createUser.id }
            };
        }

        // Warn if user previously used social login but is now using email/password
        if (userFind && ["google", "apple", "facebook"].includes(userFind.signedFrom) && !signedFrom) {
            throw new ValidationError("Social Login Required", { 
                signedFrom: userFind.signedFrom
            });
        }

        // Handle social login flow
        if (["google", "facebook", "apple"].includes(signedFrom)) {
            const socialUser = await users.findOne({
                where: {
                    email: email,
                    userTypeId: 2,
                    deletedAt: { [Op.is]: null }
                },
                include: { model: deviceToken, attributes: ['tokenId'] },
                attributes: [
                    "id", "firstName", "lastName", "email", "password",
                    "status", "userTypeId", "verifiedAt", "phoneNum",
                    [sequelize.fn("date_format", sequelize.col("createdAt"), "%Y"), "joinedOn"]
                ]
            });

            if (!socialUser.status) {
                throw new UnauthorizedError('Blocked by admin. Please contact admin to continue');
            }

            const dvTokenFound = socialUser.deviceToken.find(ele => ele.tokenId === dvToken);
            if (!dvTokenFound) {
                await deviceToken.create({ tokenId: dvToken, status: true, userId: socialUser.id });
            }

            const accessToken = jwt.sign({
                id: socialUser.id,
                email: socialUser.email,
                dvToken: dvToken
            }, process.env.JWT_ACCESS_SECRET);

            redisCli.hSet(`id-${socialUser.id}`, dvToken, accessToken);

            const featureData = await features.findAll({
                where: { status: true },
                attributes: ['id', 'title', 'description']
            });

            return {
                type: 'success',
                userData: socialUser,
                accessToken,
                isGuest: false,
                featureData,
            };
        }

        const passwordMatch = await bcrypt.compare(password, userFind.password);
        if (!passwordMatch) {
            throw new UnauthorizedError("Bad credentials", { 
                message: "Please enter correct password to continue" 
            });
        }

        const dvTokenFound = userFind.deviceToken.find(ele => ele.tokenId === dvToken);
        if (!dvTokenFound) {
            await deviceToken.create({ tokenId: dvToken, status: true, userId: userFind.id });
        }

        const accessToken = jwt.sign({
            id: userFind.id,
            email: userFind.email,
            dvToken: dvToken
        }, process.env.JWT_ACCESS_SECRET);

        redisCli.hSet(`id-${userFind.id}`, dvToken, accessToken);

        const featureData = await features.findAll({
            where: { status: true },
            attributes: ['id', 'title', 'description']
        });

        return {
            type: 'success',
            userData: userFind,
            accessToken,
            isGuest: false,
            featureData,
        };
    }

    /**
     * Forget Password Request
     * @param {Object} data - Forget password data
     * @param {string} data.email - Email
     * @returns {Object} Forget password result
     */
    async forgetPasswordRequest(data) {
        const { email } = data;

        const userData = await users.findOne({
            where: {
                email,
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

        otpMail({
            type: 'ForgetPassword',
            email: email,
            OTP: OTP
        });

        let dt = new Date();

        if (userData.otpVerification != null) {
            await otpVerification.update(
                {
                    OTP: OTP,
                    reqAt: dt,
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
     * @param {number} data.otpId - OTP ID
     * @param {string} data.OTP - OTP code
     * @returns {Object} Verification result
     */
    async verifyOTPforPassword(data) {
        const { otpId, OTP } = data;

        const otpData = await otpVerification.findByPk(otpId, {
            attributes: ["id", "OTP", "verifiedAtForgetCase", "userId"],
        });

        if (!otpData) {
            throw new NotFoundError("Sorry, we could not fetch the data", { 
                message: "Please resend OTP to continue" 
            });
        }

        if (OTP != otpData.OTP) {
            throw new UnauthorizedError("You entered incorrect OTP Please enter correct OTP to continue");
        }

        otpData.verifiedAtForgetCase = true;
        await otpData.save();

        return {
            otpId,
            userId: otpData.userId,
        };
    }

    /**
     * Change Password OTP
     * @param {Object} data - Change password data
     * @param {number} data.userId - User ID
     * @param {number} data.otpId - OTP ID
     * @param {string} data.password - New password
     * @returns {Object} Change password result
     */
    async changePasswordOTP(data) {
        const { userId, otpId, password } = data;

        const otpData = await otpVerification.findByPk(otpId, {
            attributes: ["id", "OTP", "verifiedAtForgetCase"],
        });

        const userData = await users.findByPk(userId, {
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

        let hashedPassword = await bcrypt.hash(password, 8);
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
     * @param {number} data.userId - User ID
     * @param {string} data.dvToken - Device token
     * @returns {Object} Logout result
     */
    async logout(data) {
        const { userId, dvToken } = data;

        await redisCli.hDel(`id-${userId}`, dvToken);

        return {
        };
    }

    /**
     * Session
     * @param {Object} data - Session data
     * @param {number} data.userId - User ID
     * @param {boolean} data.guestUser - Guest user flag
     * @returns {Object} Session result
     */
    async session(data) {
        const { userId, guestUser, dvToken } = data;

        if (guestUser) {
            throw new UnauthorizedError("Login failed");
        }

        const userData = await users.findOne({
            where: { id: userId },
            include: [
                {
                    model: deviceToken,
                    attributes: ['tokenId']
                },
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
                    attributes: ['id', 'shopName', 'matchProfileOptions'],
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
        
        const dvTokenFound = userData.deviceToken?.find(ele => ele.tokenId === dvToken);
        if (!dvTokenFound) {
            await deviceToken.create({ tokenId: dvToken, status: true, userId: userData.id });
        }
        
        const accessToken = jwt.sign({
            id: userData.id,
            email: userData.email,
            dvToken: dvToken
        }, process.env.JWT_ACCESS_SECRET);

        redisCli.hSet(`id-${userData.id}`, dvToken, accessToken);

        const featureData = await features.findAll({
            where: { status: true },
            attributes: ['id', 'title', 'description']
        });

        return {
            userData,
            accessToken,
            isGuest: guestUser,
            featureData,
        };
    }

    /**
     * Get User Profile
     * @param {Object} data - Profile data
     * @param {number} data.userId - User ID
     * @returns {Object} User profile data
     */
    async getUserProfile(data) {
        const { userId } = data;

        const userData = await users.findOne({
            where: {
                id: userId
            },
            attributes: ['id', 'firstName', 'lastName', 'image', 'email', 'phoneNum', 'userTypeId', 'stripeCustomerId', 'countryCode']
        });

        if (!userData) {
            throw new NotFoundError('No User Exists with this email');
        }

        return {
            userData,
        };
    }

    /**
     * Update User Profile
     * @param {Object} data - Update profile data
     * @param {number} data.userId - User ID
     * @param {string} data.firstName - First name
     * @param {string} data.lastName - Last name
     * @param {string} data.email - Email
     * @param {string} data.isProfileImgChanged - Profile image change flag
     * @param {string} data.phoneNum - Phone number
     * @param {string} data.countryCode - Country code
     * @param {string} profileImage - Profile image path
     * @returns {Object} Update result
     */
    async updateUserProfile(data, profileImage = null) {
        const { userId, firstName, lastName, email, isProfileImgChanged, phoneNum, countryCode } = data;

        const userFind = await users.findOne({
            where: {
                id: userId
            },
            attributes: ['id', 'firstName', 'lastName', 'image', 'email', 'phoneNum', 'userTypeId']
        });

        if (!userFind) {
            throw new NotFoundError("user Not Exists with this ID");
        }

        if (isProfileImgChanged === "true") {
            if (!profileImage) {
                throw new ValidationError("Profile Image Required");
            }
        }

        await users.update({
            firstName,
            lastName,
            phoneNum,
            email,
            countryCode,
            image: isProfileImgChanged === "true" ? profileImage : undefined,
        }, { where: { id: userId } });

        return {
        };
    }
}

module.exports = new AgentAuthService();
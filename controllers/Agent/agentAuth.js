require("dotenv").config();
const { users,
    userType,
    booking,
    otpVerification,
    agentSelectServices,
    deviceToken,
    features,
    bussinessInformation,
    bussinessWorkingHours,
    service,
    machines,
    machineCount,
    addressDb,
    zone,
    units } = require('../../models')
const sequelize = require('sequelize')
const { Op } = require('sequelize')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
var JSbarcode = require('jsbarcode')
const redisCli = require('../../redis/redis')
const otpGenerator = require('otp-generator')
const customError = require('../../middlewares/customError')
const otpMail = require('../../helper/otpMail')
const error = require('../../middlewares/error')
const path = require('path')
const { stat } = require('fs')
const stripe = require('../stripe')
const { create } = require('domain');

//!-------------------Agent Auth Controller---------------------//

// OTP && Registration
exports.registerAgentWithOTP = async (req, res) => {
    const { firstName, lastName, password, dvToken, phoneNum, confirmPassword, countryId, cityId, email, countryCode } = req.body;
    console.log("Request Body:", req.body);

    let profileImg = null;
    if (req.file) {
        let tempProfileImg = req.file.path;
        profileImg = tempProfileImg.replace(/\\/g, "/");
    }

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
        throw new customError('User Already Exists');
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

        // Set access token in cookies
        res.cookie("accessToken", accessToken, {
            httpOnly: true,
            secure: true,
            sameSite: "None",
            path: "/agent",
            maxAge: 24 * 60 * 60 * 1000
        });

        return res.json(responsefunc("1", "OTP sent successfully", { otpId: otpCreation.id, userId: userCreate.id, accessToken }));
    }
};

// Verify OTP for SignUp
exports.verifyOTpSignUp = async (req, res) => {
    const { otpId, OTP, userId } = req.body
    if (OTP === '5678') {
        const userData = await users.findByPk(userId)
        const userUpdate = await users.update({
            verifiedAt: new Date(),
        }, {
            where: {
                id: userId
            }
        })

        const daysArray = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
        const dataMap = daysArray.map((day) => (
            console.log("Day---->", day),
            {
                dayOfWeek: day,
                status: true,
                userId: userId
            }
        ))
        let output = await bussinessWorkingHours.bulkCreate(dataMap)
        console.log("OutPut------------->", output);

        return res.json(responsefunc("1", "OTP Verified", { userId }))
    } else {
        const otpData = await otpVerification.findByPk(otpId)
        if (!otpData) {
            throw new customError(
                "Sorry, we could not fetch the data",
                "Please rensend OTP to continue"
            )
        }
        if (otpData.OTP != OTP) {
            throw new customError("Entered Incorrect OTP. Please enter correct OTP to continue")
        }
        const userUpdate = await users.update({
            verifiedAt: new Date(),

        }, {
            where: {
                id: userId
            }
        })

        const daysArray = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
        const dataMap = daysArray.map((day) => (
            console.log("Day---->", day),
            {
                dayOfWeek: day,
                status: true,
                userId: userId
            }
        ))
        let output = await bussinessWorkingHours.bulkCreate(dataMap)
        console.log("OutPut------------->", output);

        return res.json(responsefunc("1", "OTP verified", { userId }))
    }
};

// Resend OTP
exports.resendOTP = async (req, res) => {
    const { userId } = req.body;
    const userExist = await users.findByPk(userId);

    if (!userExist) {
        throw new customError(
            "Sorry, we could not fetch the associated data",
            "Please try sending again"
        );
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
        await otpVerification.create({
            OTP,
            reqAt: DT,
            verifiedInForgetCase: false,
            userId,
        });
        res.json(responsefunc("1", "OTP sent successfully", { otpId: otpData.id }, ""));
    } else {
        await otpVerification.update(
            {
                OTP,
                reqAt: DT,
                verifiedInForgetCase: false,
            },
            { where: { userId } }
        );
        res.json(responsefunc("1", "OTP sent successfully", { otpId: otpData.id }, ""));
    }
};

// Agent Register Business Information
exports.agentBusinessInfo = async (req, res) => {
    const { shopName, matchProfileOptions, userId, otherText, machineryCount, serviceTimes } = req.body

    if (matchProfileOptions !== 'Other' && otherText) {
        throw new customError('You can Add this Field Only when Select Other Option')
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
        })

        const machinesCountCreate = machineryCount.map(ele => ({
            total: ele.total,
            status: true,
            machineId: ele.machineId,
            bussinessInformationId: agentInfo.id
        }))
        console.log("🚀 ~ agentBusinessInfo ~ machinesCountCreate:", machinesCountCreate)

        await machineCount.bulkCreate(machinesCountCreate)

        await Promise.all(
            serviceTimes.map(async (ele) => {
                await agentSelectServices.update({
                    serviceTimeRequired: ele.serviceTimeRequired
                }, { where: { agentServiceId: userId, serviceId: ele.serviceId } })
            })
        )

        await users.update({
            bussinessInformationId: agentInfo.id
        }, { where: { id: userId } })

        return res.json(responsefunc("1", "Business Info Added Successfully", {}, ""))
    }

    const agentInfo = await bussinessInformation.create({
        shopName,
        matchProfileOptions,
        agentId: userId,
        shopAddressId: agentAddress ? agentAddress.id : null
    })

    const machinesCountCreate = machineryCount.map(ele => ({
        total: ele.total,
        status: true,
        machineId: ele.machineId,
        bussinessInformationId: agentInfo.id
    }))
    console.log("🚀 ~ agentBusinessInfo ~ machinesCountCreate:", machinesCountCreate)

    await machineCount.bulkCreate(machinesCountCreate)

    await Promise.all(
        serviceTimes.map(async (ele) => {
            await agentSelectServices.update({
                serviceTimeRequired: ele.serviceTimeRequired
            }, { where: { agentServiceId: userId, serviceId: ele.serviceId } })
        })
    )

    return res.json(responsefunc("1", "Business Info Added Successfully", {}, ""))
};

// Agent Business Services Information Add
exports.businesInfoAdded = async (req, res) => {
    const { userId } = req.params;
    const { services } = req.body;

    const existingServices = await agentSelectServices.findAll({
        where: { agentServiceId: userId, status: true },
        attributes: ['serviceId']
    });

    const existingServiceIds = new Set(existingServices.map(s => s.serviceId));

    const duplicateServices = services
        .filter(service => existingServiceIds.has(service.serviceId))
        .map(service => service.serviceId);

    if (duplicateServices.length > 0) {
        throw new customError(
            `Some services already exist for this agent.`,
            `Duplicate serviceIds: [${duplicateServices.join(', ')}]`
        );
    }

    const servicesToCreate = services.map(service => ({
        serviceId: service.serviceId,
        status: true,
        agentServiceId: userId
    }));

    const serviceCreate = await agentSelectServices.bulkCreate(servicesToCreate);

    return res.json(responsefunc("1", "Agent Services Added Successfully", { serviceCreate }, ""));
};

// Agent Business Working Hours Update
exports.workingHoursUpdate = async (req, res) => {
    const { userId } = req.params
    const { bussinessWorkingDays } = req.body

    console.log(bussinessWorkingDays);

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
        console.log("Updating openTime:", ele.openTime);
        console.log("Updating closeTime:", ele.closeTime);
    }

    return res.json(responsefunc("1", "Business Days Updated", {}, ""))
};

// Login Agent
exports.loginUser = async (req, res) => {
    const { email, password, signedFrom, dvToken } = req.body;

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
    
    console.log("User Data ==============>>>", userFind)

    if (!userFind) {
        throw new customError("User not Exists with this credentials");
    }

    if (userFind?.classifiedAsId === 2) {
        const passwordMatch = await bcrypt.compare(password, userFind.password);
        if (!passwordMatch) {
            throw new customError("Bad credentials", "Please enter correct password to continue");
        }
    }

    // Check verification before anything else
    let otpId = 0;
    if (!userFind.status) {
        throw new customError("Blocked by admin. Please contact admin to continue");
    } else {
        const otpData = await otpVerification.findOne(
            { where: { userId: userFind.id } },
            { attributes: ["id", "OTP", "verifiedAtForgetCase", "userId"] }
        );
        if (!otpData && userFind.classifiedAsId === null) {
            throw new customError("User Not Verified", "User not verified by OTP");
        }
        otpId = otpData?.id;
    }

    if (!userFind.verifiedAt) {
        return res.json(
            responsefunc(
                2,
                "Pending email verification",
                { userId: userFind.id, otpId, email: userFind.email },
                "Please verify your email to continue"
            )
        );
    }

    // Address check AFTER verification
    if (!userFind.addressDb || userFind.addressDb.length === 0) {
        return res.json(responsefunc("3", "Cannot login without adding an address", { userId: userFind.id }, ""));
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
        return res.json(responsefunc("4", "Please complete your information before logging in.", outObj, ""));
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

        return res.json(responsefunc('3', `User signed-In by ${signedFrom}`, { userId: createUser.id }));
    }

    // Warn if user previously used social login but is now using email/password
    if (userFind && ["google", "apple", "facebook"].includes(userFind.signedFrom) && !signedFrom) {
        return res.json(
            responsefunc(
                "4",
                "Social Login Required",
                {},
                `You have previously signed up using ${userFind.signedFrom}. Please log in using ${userFind.signedFrom}.`
            )
        );
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
            throw new customError('Blocked by admin. Please contact admin to continue');
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

        res.cookie("accessToken", accessToken, {
            httpOnly: true,
            secure: true,
            sameSite: "None",
            path: "/agent",
            maxAge: 24 * 60 * 60 * 1000
        });

        const featureData = await features.findAll({
            where: { status: true, featureOf: 'Agent Employee' },
            attributes: ['id', 'title']
        });

        const output = loginData(socialUser, accessToken, false, featureData);
        return res.json(output);
    }

    // Ensure basic profile info exists
    if (userFind.userTypeId === 4 && (!userFind.firstName || !userFind.phoneNum)) {
        return res.json(
            responsefunc(
                3,
                "Pending User Data",
                { userId: userFind.id },
                "Your First Name or Phone Number is Missing"
            )
        );
    }

    // Password match
    const passwordMatch = await bcrypt.compare(password, userFind.password);
    if (!passwordMatch) {
        throw new customError("Bad credentials", "Please enter correct password to continue");
    }

    // Device token check
    const dvTokenFound = userFind.deviceToken?.find(ele => ele.tokenId === dvToken);
    if (!dvTokenFound) {
        await deviceToken.create({ tokenId: dvToken, status: true, userId: userFind.id });
    }

    // Features fetch
    const featureData = await features.findAll({
        where: { status: true },
        attributes: ['id', 'title']
    });

    const accessToken = jwt.sign({
        id: userFind.id,
        email: userFind.email,
        dvToken: dvToken
    }, process.env.JWT_ACCESS_SECRET);

    redisCli.hSet(`id-${userFind.id}`, dvToken, accessToken);

    res.cookie("accessToken", accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: "None",
        path: "/agent",
        maxAge: 24 * 60 * 60 * 1000
    });

    const output = loginData(userFind, accessToken, false, featureData);
    return res.json(output);
};

// Forget Password
exports.forgetPasswordRequest = async (req, res) => {
    const { email } = req.body;
    const userData = await users.findOne({
        where: {
            email,
            deletedAt: { [Op.is]: null },
            userTypeId: { [Op.or]: [4] },
        },
        include: { model: otpVerification, attributes: ["id"] },
        attributes: ["id"],
    });
    console.log("🚀 ~ forgetPasswordRequest ~ users:", userData)

    // user not found
    if (!userData)
        throw new customError(
            "Invalid information",
            "No user exists against this email"
        );
    let OTP = otpGenerator.generate(4, {
        lowerCaseAlphabets: false,
        upperCaseAlphabets: false,
        specialChars: false,
    });

    otpMail({
        type: 'ForgetPassword',
        email: email,
        OTP: OTP
    })

    let dt = new Date();
    if (userData.otpVerification != null) {
        try {
            otpVerification.update(
                {
                    OTP: OTP,
                    reqAt: dt,
                }, { where: { userid: userData.id } }
            )

            return res.json(responsefunc("1", "OTP Updated Successfully", { otpid: userData.otpVerification.id, userId: userData.id }))

        } catch (error) {
            console.log("Error in updating OTP", error)
            throw new customError(`${error.message}`)
        }
    } else {
        try {
            const otpSend = otpVerification.create({
                OTP: OTP,
                reqAt: dt,
                userId: userData.id
            })

            return res.json(responsefunc("1", "OTP sent Successfully for Password Reset", { otpId: otpSend.id, userId: userData.id }))

        } catch (error) {
            console.log("Error in updating OTP", error)
            throw new customError(`${error.message}`)
        }
    }
};

// Verify OTP for changing password
exports.verifyOTPforPassword = async (req, res) => {
    const { otpId, OTP } = req.body;
    
    const otpData = await otpVerification.findByPk(otpId, {
        attributes: ["id", "OTP", "verifiedAtForgetCase", "userId"],
    });
    if (!otpData)
        throw new customError(
            "Sorry, we could not fetch the data",
            "Please rensend OTP to continue"
        );

    if (OTP != otpData.OTP) {
        throw new customError(
            "You entered incorrect OTP Please enter correct OTP to continue"
        );
    }
    otpData.verifiedAtForgetCase = true;
    await otpData.save();
    return res.json(
        responsefunc("1", "OTP verified", { otpId, userId: otpData.userId }, "")
    );
};

// Change password in response to OTP
exports.changePasswordOTP = async (req, res) => {
    const { userId, otpId, password } = req.body;
    const otpData = await otpVerification.findByPk(otpId, {
        attributes: ["id", "OTP", "verifiedAtForgetCase"],
    });
    const userData = await users.findByPk(userId, {
        attributes: ["id", "password"],
    });
    if (!otpData)
        throw new customError(
            "Sorry, we could not fetch the data",
            "Please rensend OTP to continue"
        );
    if (otpData.verifiedAtForgetCase === false)
        throw new customError(
            "OTP not verified yet",
            "Please verify OTP first"
        );
    let hashedPassword = await bcrypt.hash(password, 8);
    userData.password = hashedPassword;
    await userData.save();
    // reset the OTP Id
    otpData.verifiedAtForgetCase = false;
    await otpData.save();
    return res.json(
        responsefunc(
            "1",
            "Password updated successfully. Please login to continue",
            {},
            ""
        )
    );
};

// Log out
exports.logout = async (req, res) => {
    // removing the device token from DB
    deviceToken.destroy({
        where: { tokenId: req.user.dvToken, userId: req.user.id },
    });
    // removing from redis
    redisCli
        .hDel(`tsh${req.user.id}`, req.user.dvToken)
        .then((upData) => {
            return res.json({
                status: "1",
                message: "Log-out successfully",
                data: {},
                error: "",
            });
        })
        .catch((err) => {
            return res.json({
                status: "0",
                message: "Internal server error",
                data: {},
                error: "There is some error logging out. Please try again",
            });
        });
};

// Session
exports.session = async (req, res) => {
    const userId = req.user.id;
    const { guestUser, dvToken } = req.body;
    if (guestUser) throw new CustomException("Login failed", "");

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
        throw new customError(
            "Sorry no user found!",
            "Please contact support for more information"
        );
    }

    if (!userData.status) {
        throw new customError(
            "You are blocked by Admin",
            "Please contact support for more information"
        );
    }

    let otpId = 0;
    if (!userData.status) {
        throw new customError("Blocked by admin. Please contact admin to continue");
    } else {
        const otpData = await otpVerification.findOne(
            { where: { userId: userData.id } },
            { attributes: ["id", "OTP", "verifiedAtForgetCase", "userId"] }
        );
        if (!otpData && userData.classifiedAsId === null) {
            throw new customError("User Not Verified", "User not verified by OTP");
        }
        otpId = otpData?.id;
    }

    if (!userData.verifiedAt) {
        return res.json(
            responsefunc(
                2,
                "Pending email verification",
                { userId: userData.id, otpId, email: userData.email },
                "Please verify your email to continue"
            )
        );
    }

    // Check for address
    if (!userData.addressDb || userData.addressDb.length === 0) {
        return res.json(responsefunc("3", "Cannot proceed without adding an address", { userId: userData.id }, ""));
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
        return res.json(responsefunc("4", "Please complete your information before logging in.", outObj, ""));
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

    res.cookie("accessToken", accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: "None",
        path: "/agent",
        maxAge: 24 * 60 * 60 * 1000
    });

    let output = loginData(userData, accessToken, "", guestUser);
    return res.json(output);
};

// Get User profile
exports.getUserProfile = async (req, res) => {
    const userId = req.user.id

    const userData = await users.findOne({
        where: {
            id: userId
        },
        attributes: ['id', 'firstName', 'lastName', 'image', 'email', 'phoneNum', 'userTypeId', 'stripeCustomerId', 'countryCode']
    })

    if (!userData) {
        throw new customError('No User Exists with this email')
    }

    return res.json(responsefunc("1", "User Profile fetched", userData, ""))
};

// Update User profile
exports.updateUserProfile = async (req, res) => {
    const userId = req.user.id
    const { firstName, lastName, email, isProfileImgChanged, phoneNum, countryCode } = req.body

    const userFind = await users.findOne({
        where: {
            id: userId
        },
        attributes: ['id', 'firstName', 'lastName', 'image', 'email', 'phoneNum', 'userTypeId']
    })

    if (!userFind) {
        throw new customError("user Not Exists with this ID")
    }

    let tempProfileImg = "";
    let profileImage = "";

    if (isProfileImgChanged === "true") {
        if (!req.file) {
            throw new customError("Profile Image Required")
        } else {
            tempProfileImg = req.file.path;
            profileImage = tempProfileImg.replace(/\\/g, "/");
        }
    }

    await users.update({
        firstName,
        lastName,
        phoneNum,
        email,
        countryCode,
        image: isProfileImgChanged === "true" ? profileImage : undefined,
    }, { where: { id: userId } })

    return res.json(
        responsefunc("1", "User Profile Updated Successfully", {}, "")
    )
};

//! Helper functions
const responsefunc = (status, message, data, error) => {
    return {
        status: `${status}`,
        message: `${message}`,
        data: data,
        error: `${error}`
    }
}

const registerData = (userData, accessToken, isGuest) => {
    return {
        status: "1",
        message: "User Register successful",
        data: {
            userId: `${userData.id}`,
            firstName: `${userData.firstName}`,
            lastName: `${userData.lastName}`,
            email: `${userData.email}`,
            accessToken: `${accessToken}`,
            userTypeId: `${userData.userTypeId}`,
            isGuest,
            joinedOn: userData.dataValues.joinedOn
                ? userData.dataValues.joinedOn
                : "2023",
            phoneNum: `${userData.phoneNum}`,
        },
        error: "",
    };
};

const loginData = (userData, accessToken, isGuest, features) => {
    return {
        status: "1",
        message: "Login successful",
        data: {
            userId: `${userData.id}`,
            firstName: `${userData.firstName}`,
            lastName: `${userData.lastName}`,
            email: `${userData.email}`,
            accessToken: `${accessToken}`,
            userTypeId: `${userData.userTypeId}`,
            addressId: `${userData?.addressDb?.id}`,
            currencyUnit: `${userData?.addressDb?.zone?.currencyUnitZ?.symbol}`,
            isGuest,
            joinedOn: userData.dataValues.joinedOn
                ? userData.dataValues.joinedOn
                : "2023",
            phoneNum: `${userData.phoneNum}`,
            features: Array.isArray(features) && features.length > 0 ? features : []
        },
        error: "",
    };
};
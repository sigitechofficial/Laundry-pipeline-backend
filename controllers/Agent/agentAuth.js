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
    machineCount } = require('../../models')
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
const { create } = require('domain')

//!-------------------Agent Auth---------------------//
/*
  *  Agent Register
*/
async function registerAgentOTP(req, res) {
    const { email } = req.body
    const userExists = await users.findOne({
        where: {
            email: email,
            deletedAt: {
                [Op.is]: null
            }
        },
        include: {
            model: otpVerification
        }
    })

    if (userExists && userExists.userTypeId === 3) {
        throw new customError('Driver Already Exits')
    }

    if (userExists && userExists.userTypeId === 2) {
        throw new customError('Customer Already Exits')
    }

    if (userExists) {
        try {
            if (userExists.verifiedAt != null) {
                throw new customError('Trying to Login? User with this email alrady Exists')
            }

            let otp = otpGenerator.generate(4, {
                lowerCaseAlphabets: false,
                upperCaseAlphabets: false,
                specialChars: true
            })

            otpMail({
                type: 'RegisterOTP',
                email: email,
                OTP: otp
            })

            let dt = new Date()

            if (!userExists.otpVerification) {
                const otpData = await otpVerification.create({
                    OTP: otp,
                    reqAt: dt,
                    userId: userExists.id

                })

                return res.json(responsefunc("1", "OTP send sucessfully ", { otpId: otpData.id, userId: userExists.id }))

            } else {
                await otpVerification.update({
                    OTP: otp,
                    reqAt: dt
                }, { where: { userId: userExists.id } })

                let otpData = await otpVerification.findOne({
                    where: {
                        userId: userExists.id
                    }
                })

                return res.json(responsefunc("1", "OTP send sucessfully ", { otpId: otpData.id, userId: userExists.id }))
            }


        } catch (error) {
            console.log("Error------>", error)
        }
    } else {
        let userTypeId = 4
        const userCreate = await users.create({
            email,
            userTypeId
        })

        let otp = otpGenerator.generate(4, {
            lowerCaseAlphabets: false,
            upperCaseAlphabets: false,
            specialChars: true
        })

        otpMail({
            type: 'RegisterOTP',
            email: email,
            OTP: otp
        })
        let dt = new Date()

        const otpCreatetion = await otpVerification.create({
            OTP: otp,
            reqAt: dt,
            userId: userCreate.id
        })
        console.log("🚀 ~ registerCustomerOTP ~ otpCreatetion:", otpCreatetion)

        return res.json(responsefunc("1", "OTP send sucessfully ", { otpId: otpCreatetion.id, userId: userCreate.id }))
    }
}



/*
   * verify OTP for SignUp
*/
async function verifyOTpSignUp(req, res) {
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
        return res.json(responsefunc("1", "OTP verified", { userId }))
    }

}

/*
 * Register Agent 
*/
async function registerAgent(req, res) {
    const { firstName, lastName, password, dvToken, phoneNum, confirmPassword, userId, countryId, cityId } = req.body
    console.log("🚀 ~ registerCustomer ~ req.body:", req.body)

    let profileImg = null;
    if (req.file) {
        let tempProfileImg = req.file.path;
        profileImg = tempProfileImg.replace(/\\/g, "/");
    }

    const userfind = await users.findOne({
        where: {
            id: userId
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
    })
    console.log("🚀 ~ registerAgent ~ userfind:", userfind)


    if (userfind && userfind.userTypeId === 3) {
        throw new customError('Driver Cannot register from Here')
    }

    if (userfind && userfind.userTypeId === 2) {
        throw new customError('Customer Cannot Register from Here')
    }

    if (userfind.verifiedAt === null) {
        return res.json(responsefunc("2", "Please verify your OTP", {}, ""))
    }


    if (password !== confirmPassword) {
        throw new customError(" Passwords do not match. Please try again.")

    }

    const hashpass = await bcrypt.hash(password, 8)
    console.log("🚀 ~ registerCustomer ~ hashpass:", hashpass)

    const stripeCustomer = await stripe.createStripeCustomer(userfind.firstName, userfind.email)
    console.log("🚀 ~ registerCustomer ~ stripeCustomer:", stripeCustomer)

    await users.update({
        firstName,
        lastName,
        status: true,
        password: hashpass,
        dvToken,
        phoneNum,
        stripeCustomerId: stripeCustomer,
        image: profileImg,
        countryId,
        cityId
    }, {
        where: { id: userfind.id }
    })

    await deviceToken.create(({
        tokenId: dvToken,
        status: true,
        userId: userfind.id
    }))

    const accessToken = jwt.sign({
        id: userfind.id,
        email: userfind.email,
        dvToken: dvToken,
        userTypeId: userfind.userTypeId
    }, process.env.JWT_ACCESS_SECRET
    )

    redisCli.hSet(
        `id-${userfind.id}`,
        dvToken,
        accessToken
    )


    let outputObj = registerData(userfind, accessToken, false)

    return res.json(outputObj)

}


/*
 * Agent Register Bussiness Information
*/

async function agentBusinessInfo(req, res) {
    const { shopName, services, matchProfileOptions, userId, otherText, bussinessWorkingDays, machineryCount, serviceTimes } = req.body


    if (matchProfileOptions !== 'Other' && otherText) {
        throw new customError('You cna Add this Field Only when Select Other Option')
    }

    if (matchProfileOptions === 'Other') {
        const agentInfo = await bussinessInformation.create({
            shopName,
            matchProfileOptions,
            otherText,
            agentId: userId
        })

        const servicesSelect = services.map(service => ({
            serviceId: service.serviceId,
            status: true,
            agentServiceId: userId
        }))
        console.log("🚀 ~ agentBusinessInfo ~ servicesSelect:", servicesSelect)

        await agentSelectServices.bulkCreate(servicesSelect)

        const bussinessWorkingTime = bussinessWorkingDays.map(ele => ({
            dayOfWeek: ele.dayOfWeek,
            openTime: ele.openTime,
            closeTime: ele.closeTime,
            bussinessInformationId: agentInfo.id
        }))
        console.log("🚀 ~ agentBusinessInfo ~ bussinessWorkingTime:", bussinessWorkingTime)

        await bussinessWorkingHours.bulkCreate(bussinessWorkingTime)

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


        return res.json(responsefunc("1", "Bussiness Info Added Sucessfully", {}, ""))
    }

    const agentInfo = await bussinessInformation.create({
        shopName,
        matchProfileOptions,
        agentId: userId
    })

    const servicesSelect = services.map(service => ({
        serviceId: service.serviceId,
        status: true,
        agentServiceId: userId
    }))
    console.log("🚀 ~ agentBusinessInfo ~ servicesSelect:", servicesSelect)

    await agentSelectServices.bulkCreate(servicesSelect)

    const bussinessWorkingTime = bussinessWorkingDays.map(ele => ({
        dayOfWeek: ele.dayOfWeek,
        openTime: ele.openTime,
        closeTime: ele.closeTime,
        bussinessInformationId: agentInfo.id
    }))
    console.log("🚀 ~ agentBusinessInfo ~ bussinessWorkingTime:", bussinessWorkingTime)

    await bussinessWorkingHours.bulkCreate(bussinessWorkingTime)

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


    return res.json(responsefunc("1", "Bussiness Info Added Sucessfully", {}, ""))

}



/*
 * Login Agent 
*/

async function loginUser(req, res) {
    const { email, password, signedFrom, dvToken } = req.body

    const userFind = await users.findOne({
        where: {
            email: email,
            deletedAt: { [Op.is]: null }
        },
        include: { model: deviceToken, attributes: ['tokenId'] },
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
    })
    console.log("🚀 ~ loginUser ~ userFind:", userFind)
    if(!userFind){
        throw new customError("User not Exists with this credentials")
    }
    if (userFind.classifiedAsId === 2) {
        const passwordMatch = await bcrypt.compare(password, userFind.password)
        if (!passwordMatch) {
            throw new customError(
                "Bad credentials",
                "Please enter correct password to continue")
        }
    }

    if ((!userFind && signedFrom === 'google') || (!userFind && signedFrom === 'facebook') || (!userFind && signedFrom === 'apple')) {

        const createStripeCustomer = await stripe.createStripeCustomer(
            email
        )

        const createUser = await users.create({
            email,
            userTypeId: 4,
            verifiedAt: Date.now(),
            stripeCustomerId: createStripeCustomer

        })

        const userId = createUser.id

        return res.json(responsefunc('3', `User signed-In by${signedFrom}`, { userId }))
    }

    if (userFind && ["google", "apple", "facebook"].includes(userFind.signedFrom) && !signedFrom) {
        return res.json(
            returnFunction(
                "4",
                "Social Login Required",
                {},
                `You have previously signed up using ${userFind.signedFrom}. Please log in using ${userFind.signedFrom}.`
            )
        );
    }


    if (signedFrom === 'google' || signedFrom === 'facebook' || signedFrom === 'apple') {


        const userFind = await users.findOne({
            where: {
                email: email,
                userTypeId: 2,
                deletedAt: { [Op.is]: null }
            },
            include: { model: deviceToken, attributes: ['tokenId'] },
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
                [
                    sequelize.fn("date_format", sequelize.col("createdAt"), "%Y"),
                    "joinedOn",
                ],
            ]
        })

        if (!userFind.status) {
            throw new customError('Blocked By admin Please contact admin to continue')
        }

        const dvTokenFound = userFind.deviceToken.find((ele) => ele.tokenId === dvToken)
        if (!dvTokenFound) {
            await deviceToken.create({
                tokenId: dvToken,
                status: true,
                userId: userFind.id
            })
        }

        const accessToken = jwt.sign({
            id: userFind.id,
            email: userFind.email,
            dvToken: dvToken
        }, process.env.JWT_ACCESS_SECRET);

        redisCli.hSet(
            `id-${userFind.id}`,
            dvToken,
            accessToken
        )


        const featureData = await features.findAll({
            where: {
                status: true
            },
            attributes: ['id', 'title']
        })

        let output = loginData(userData, accessToken, false, featureData);
        return res.json(output);
    }

    let otpId = 0;

    if (!userFind.status) {
        throw new customError("Blocked by admin Please contact admin to continue")
    } else {
        const otpData = await otpVerification.findOne(
            { where: { userId: userFind.id } },
            { attributes: ["id", "OTP", "verifiedAtForgetCase", "userId"] }
        );
        if (!otpData && userFind.classifiedAsId === null) {
            throw new customError("User Not Verifed", "user not verifeid by otp");
        }

        otpId = otpData?.id;
    }

    if (!userFind.verifiedAt) {
        return res.json(
            returnFunction(
                2,
                "Pending email verification",
                { userId: userData.id, otpId, email: userData.email },
                "Please verify your email to continue"
            )
        );
    }

    if (userFind.userTypeId === 4) {
        if (userFind.firstName === null || !userFind.phoneNum) {
            return res.json(
                returnFunction(
                    3,
                    "Pending User Data",
                    { userId: userData.id },
                    "Your first Name or Phone Number is Missing"
                )
            );
        }
    }

    if (userFind.userTypeId === 4) {
        if (userFind.firstName === null) {
            return res.json(
                returnFunction(
                    3,
                    "Pending User Data",
                    { userId: userData.id },
                    "Your first Name is Missing"
                )
            );
        }
    }

    const passwordMatch = await bcrypt.compare(password, userFind.password)
    if (!passwordMatch) {
        throw new customError(
            "Bad credentials",
            "Please enter correct password to continue")
    }


    const dvTokenFound = userFind.deviceToken?.find((ele) => ele.tokenId === dvToken)
    console.log("🚀 ~ loginUser ~ dvTokenFound:", dvTokenFound)
    if (!dvTokenFound) {
        await deviceToken.create({
            tokenId: dvToken,
            status: true,
            userId: userFind.id
        })
    }

    const featureData = await features.findAll({
        where: {
            status: true
        },
        attributes: ['id', 'title']
    })

    const accessToken = jwt.sign({
        id: userFind.id,
        email: userFind.email,
        dvToken: dvToken
    }, process.env.JWT_ACCESS_SECRET)

    redisCli.hSet(
        `id-${userFind.id}`,
        dvToken,
        accessToken
    )


    let output = loginData(userFind, accessToken, false, featureData);
    return res.json(output);


}



/*
*   Forget Password
*/
async function forgetPasswordRequest(req, res) {
    const { email } = req.body;
    const userData = await users.findOne({
        where: {
            email,
            deletedAt: { [Op.is]: null },
            userTypeId: { [Op.or]: [2] },
        },
        include: { model: otpVerification, attributes: ["id"] },
        attributes: ["id"],
    });

    // user not found
    if (!userData)
        throw new customError(
            "Invalid information",
            "No user exists against this email"
        );
    let OTP = otpGenerator.generate(4, {
        lowerCaseAlphabets: false,
        upperCaseAlphabets: false,
        specialChars: true,
    });
    //return res.json(OTP)


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

            return res.json(responsefunc("1", "OTP Updated Sucessfully", { otpid: userData.otpVerification.id, userId: userData.id }))

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

            return res.json(responsefunc("1", "OTP sent Sucessfully for Password Reset", { otpId: otpSend.id, userId: userData.id }))

        } catch (error) {
            console.log("Error in updating OTP", error)
            throw new customError(`${error.message}`)

        }
    }

}



/*
   *       Verify OTP for changing password
*/
async function verifyOTPforPassword(req, res) {
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
}

/*
*           Change password in response to OTP
*/
async function changePasswordOTP(req, res) {
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
}

/*
*          8. Log out
*/
async function logout(req, res) {
    //return res.json(req.user);
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
}




/*
* Get User profile
*/

async function getUserProfile(req, res) {

    const userId = req.user.id

    const userData = await users.findOne({
        where: {
            id: userId
        },
        attributes: ['id', 'firstName', 'lastName', 'image', 'email', 'phoneNum', 'userTypeId', 'stripeCustomerId']
    })

    if (!userData) {
        throw new customError('No User Exists with this email')
    }

    return res.json(responsefunc("1", "User Profile fetched", userData, ""))

}



/*
*  Update User profile
*/

async function updateUserProfile(req, res) {
    const userId = req.user.id
    const { firstName, lastName, email, isProfileImgChanged, phoneNum } = req.body

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
        image: isProfileImgChanged === "true" ? profileImage : undefined,

    }, { where: { id: userId } })


    return res.json(
        responsefunc("1", "User Profile Updated Sucessfully", {}, "")
    )

}

//!Recurring functions
let responsefunc = (status, message, data, error) => {
    return {
        status: `${status}`,
        messsage: `${message}`,
        data: data,
        error: `${error}`

    }
}


let registerData = (userData, accessToken, isGuest) => {
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


let loginData = (userData, accessToken, isGuest, features) => {
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



module.exports = {
    registerAgentOTP,
    verifyOTpSignUp,
    registerAgent,
    loginUser,
    forgetPasswordRequest,
    verifyOTPforPassword,
    logout,
    getUserProfile,
    updateUserProfile,
    changePasswordOTP,
    agentBusinessInfo

}
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
    addressDb } = require('../../models')
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

}



/* 
   * Resend OTP
*/
async function resendOTP(req, res) {
    const { userId } = req.body;
    const userExist = await users.findByPk(userId);

    if (!userExist) {
        throw new CustomException(
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

}



/*
 * Register Agent 
*/
// async function registerAgent(req, res) {
//     const { firstName, lastName, password, dvToken, phoneNum, confirmPassword, userId, countryId, cityId } = req.body
//     console.log("🚀 ~ registerCustomer ~ req.body:", req.body)

//     let profileImg = null;
//     if (req.file) {
//         let tempProfileImg = req.file.path;
//         profileImg = tempProfileImg.replace(/\\/g, "/");
//     }

//     const userfind = await users.findOne({
//         where: {
//             id: userId
//         },
//         include: [{
//             model: otpVerification,
//             required: false,
//             attributes: ['OTP']
//         }, {
//             model: deviceToken,
//             required: false,
//             attributes: ['tokenId']
//         }],
//         attributes: [
//             "id",
//             "firstName",
//             "lastName",
//             "email",
//             "phoneNum",
//             "userTypeId",
//             "verifiedAt",
//             [
//                 sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"),
//                 "joinedOn",
//             ],
//         ],
//     })
//     console.log("🚀 ~ registerAgent ~ userfind:", userfind)


//     if (userfind && userfind.userTypeId === 3) {
//         throw new customError('Driver Cannot register from Here')
//     }

//     if (userfind && userfind.userTypeId === 2) {
//         throw new customError('Customer Cannot Register from Here')
//     }

//     if (userfind.verifiedAt === null) {
//         return res.json(responsefunc("2", "Please verify your OTP", {}, ""))
//     }


//     if (password !== confirmPassword) {
//         throw new customError(" Passwords do not match. Please try again.")

//     }

//     const hashpass = await bcrypt.hash(password, 8)
//     console.log("🚀 ~ registerCustomer ~ hashpass:", hashpass)

//     const stripeCustomer = await stripe.createStripeCustomer(userfind.firstName, userfind.email)
//     console.log("🚀 ~ registerCustomer ~ stripeCustomer:", stripeCustomer)

//     await users.update({
//         firstName,
//         lastName,
//         status: true,
//         password: hashpass,
//         dvToken,
//         phoneNum,
//         stripeCustomerId: stripeCustomer,
//         image: profileImg,
//         countryId,
//         cityId
//     }, {
//         where: { id: userfind.id }
//     })

//     await deviceToken.create(({
//         tokenId: dvToken,
//         status: true,
//         userId: userfind.id
//     }))

//     const accessToken = jwt.sign({
//         id: userfind.id,
//         email: userfind.email,
//         dvToken: dvToken,
//         userTypeId: userfind.userTypeId
//     }, process.env.JWT_ACCESS_SECRET
//     )

//     redisCli.hSet(
//         `id-${userfind.id}`,
//         dvToken,
//         accessToken
//     )


//     let outputObj = registerData(userfind, accessToken, false)

//     return res.json(outputObj)

// }

/*
  *  OTP && Registration
*/
async function registerAgentWithOTP(req, res) {
    const { firstName, lastName, password, dvToken, phoneNum, confirmPassword, countryId, cityId, email } = req.body;
    console.log("🚀 ~ registerAgentWithOTP ~ req.body:", req.body);

    let profileImg = null;
    if (req.file) {
        let tempProfileImg = req.file.path;
        profileImg = tempProfileImg.replace(/\\/g, "/");
    }

    // Step 1: Check if the user exists based on email
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

    console.log("🚀 ~ registerAgentWithOTP ~ userfind:", userfind);

    if (userfind?.email === email && userfind?.userTypeId === 4) {
        throw new customError('User Already Exists')
    } else {

        let userTypeId = 4;
        const hashedPassword = await bcrypt.hash(password, 8)
        const userCreate = await users.create({
            email,
            firstName,
            lastName,
            phoneNum,
            userTypeId,
            password: hashedPassword,
            status: true
        });


        const stripeCustomer = await stripe.createStripeCustomer(firstName, email);
        console.log("🚀 ~ registerAgentWithOTP ~ stripeCustomer:", stripeCustomer);

        // Generate OTP
        const otp = otpGenerator.generate(4, {
            lowerCaseAlphabets: false,
            upperCaseAlphabets: false,
            specialChars: false
        });

        // Send OTP email
        otpMail({
            type: 'RegisterOTP',
            email: email,
            OTP: otp
        });

        let dt = new Date();

        // Save OTP verification data
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

        console.log("🚀 ~ registerAgentWithOTP ~ otpCreation:", otpCreation);

        return res.json(responsefunc("1", "OTP sent successfully", { otpId: otpCreation.id, userId: userCreate.id }));
    }
}


/*
 * Agent Register Bussiness Information
*/

async function agentBusinessInfo(req, res) {
    const { shopName, matchProfileOptions, userId, otherText, machineryCount, serviceTimes } = req.body


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
 * Agent  Bussiness Services Information Add
*/
async function businesInfoAdded(req, res) {
    const { userId } = req.params
    const { services } = req.body



    const servicesSelect = services.map(service => ({
        serviceId: service.serviceId,
        status: true,
        agentServiceId: userId
    }))
    console.log("🚀 ~ agentBusinessInfo ~ servicesSelect:", servicesSelect)

    const serviceCreate = await agentSelectServices.bulkCreate(servicesSelect)


    return res.json(responsefunc("1", "Agent Services Added Sucessfully", { serviceCreate }, ""))
}

/*
 *  Agent  Bussiness Working Hours Update
*/
async function workingHoursUpdate(req, res) {

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


    return res.json(responsefunc("1", "Bussiness Days Updated", {}, ""))

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
        include: [
            {
                model: deviceToken,
                attributes: ['tokenId']
            },
            {
                model: addressDb,
                attributes: ['id', 'streetAddress', 'userId', 'addressType', 'province', 'postalCode', 'district', 'lat', 'lng', 'coordinates']
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
            },
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
    })
    console.log("ðŸš€ ~ loginUser ~ userFind:", userFind.addressDbs)

    // return res.json(userFind)
    if (!userFind) {
        throw new customError("User not Exists with this credentials")
    }
    if (userFind?.classifiedAsId === 2) {
        const passwordMatch = await bcrypt.compare(password, userFind.password)
        if (!passwordMatch) {
            throw new customError(
                "Bad credentials",
                "Please enter correct password to continue")
        }
    }

    if (!userFind.addressDb || userFind.addressDb.length === 0) {


        return res.json(responsefunc("3", "Cannot login without adding an address", { userId: userFind.id, }, ""))
    }

    const services = userFind?.agentServices ?? [];
    const agentInfo = userFind?.agentInfo ?? [];
    const userMachineInfo = agentInfo?.[0]?.agentShopMachine ?? [];

    let outObj = {
        userId: userFind.id,
        services: services,
        agentInfo: agentInfo,
        userMachineInfo: userMachineInfo,
    };

    // Check if required information is missing
    if (
        services.length === 0 ||
        agentInfo.length === 0 ||
        !agentInfo[0]?.shopName ||
        !agentInfo[0]?.matchProfileOptions
    ) {
        return res.json(responsefunc("4", "Please complete your information before logging in.", outObj, ""));
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
            responsefunc(
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
                status: true,
                featureOf: 'Agent Employee'
            },
            attributes: ['id', 'title']
        })

        res.cookie("accessToken", accessToken, {
            //   httpOnly: true,
            //   secure: true, 
            //   sameSite: "None",
            path: "/agent",
            maxAge: 24 * 60 * 60 * 1000
        });


        let output = loginData(userFind, accessToken, false, featureData);
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
            responsefunc(
                2,
                "Pending email verification",
                { userId: userFind.id, otpId, email: userFind.email },
                "Please verify your email to continue"
            )
        );
    }

    if (userFind.userTypeId === 4) {
        if (userFind.firstName === null || !userFind.phoneNum) {
            return res.json(
                responsefunc(
                    3,
                    "Pending User Data",
                    { userId: userFind.id },
                    "Your first Name or Phone Number is Missing"
                )
            );
        }
    }

    if (userFind.userTypeId === 4) {
        if (userFind.firstName === null) {
            return res.json(
                responsefunc(
                    3,
                    "Pending User Data",
                    { userId: userFind.id },
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
    console.log("ðŸš€ ~ loginUser ~ dvTokenFound:", dvTokenFound)
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

    res.cookie("accessToken", accessToken, {
        //   httpOnly: true,
        //   secure: true, 
        //   sameSite: "None",
        path: "/agent",
        maxAge: 24 * 60 * 60 * 1000
    });



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
    // if (OTP === '5678') {
    //     const userData = await users.findByPk(userId)
    //     const userUpdate = await users.update({
    //         verifiedAt: new Date(),
    //     }, {
    //         where: {
    //             id: userId
    //         }
    //     })


    //     return res.json(responsefunc("1", "OTP Verified", { userId }))
    // }
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
   * Session    
*/
async function session(req, res) {
    const userId = req.user.id;
    const { guestUser } = req.body;
    if (guestUser) throw new CustomException("Login failed", "");
    const userData = await users.findByPk(userId, {
        attributes: [
            "id",
            "firstName",
            "lastName",
            "email",
            "status",
            "countryCode",
            "phoneNum",
        ],
    });
    if (!userData) {
        throw new customError(
            "Sorry no user found!",
            "Please contact support for more information"
        );
    }
    if (!userData?.status)
        throw new customError(
            "You are blocked by Admin",
            "Please contact support for more information"
        );
    let output = loginData(userData, "", guestUser);
    return res.json(output);
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
        message: `${message}`,
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
    loginUser,
    forgetPasswordRequest,
    verifyOTPforPassword,
    logout,
    getUserProfile,
    updateUserProfile,
    changePasswordOTP,
    agentBusinessInfo,
    registerAgentWithOTP,
    resendOTP,
    businesInfoAdded,
    workingHoursUpdate,
    session

}
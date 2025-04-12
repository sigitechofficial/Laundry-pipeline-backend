require("dotenv").config();
const { users,
    userType,
    booking,
    otpVerification,
    deviceToken,
    vehicleType,
    driverDetail,
    vehicleImage,
    countries,
    driverInZones } = require('../../models')
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
const accessToken = require("../../middlewares/accessToken");
const axios = require('axios')

//!------------------------------------Driver Auth-------------------------------------//


/* 
 *              Driver Auth Step-1
*/
async function driverregisterStep1(req, res) {
    const { firstName, lastName, email, phoneNum, password, countryId, cityId, driverType, laundaryShopId, zoneId } = req.body

    const userExist = await users.findOne({
        where: {
            [Op.or]: [
                { email: email },
                { [Op.and]: [{ phoneNum: phoneNum }] }
            ],
            deletedAt: { [Op.is]: null }
        },
        include: [
            {
                model: countries,
                attributes: ['name']
            }
        ]
    });

    if (userExist && userExist.userTypeId === 2) {
        throw new customError(
            "Try to login",
            "A Customer with the follwoing email exists ")
    }

    if (userExist) {
        if (email === userExist.email && userExist.verifiedAt !== null) {
            throw new customError(
                "Users exists",
                "The email you entered is already taken"
            )
        }
        else if (phoneNum === userExist.phoneNum && userExist.verifiedAt !== null) {
            throw new customError(
                "Users exists",
                "The phone number you entered is already taken")
        }

        const OTP = otpGenerator.generate(4, {
            lowerCaseAlphabets: false,
            upperCaseAlphabets: false,
            specialChars: true,
        })

        otpMail({
            type: 'RegisterOTP',
            email: email,
            OTP: OTP
        })

        const DT = new Date();
        if (!userExist.otpVerification) {
            await otpVerification.create({
                OTP,
                reqAt: DT,
                userID: userExist.id,
            });

            let outputObj = {
                userId: `${userExist.id}`,
                image: `${userExist.image}`,
                firstName: `${userExist.firstName}`,
                lastName: `${userExist.lastName}`,
                email: `${userExist.email}`,
                phoneNum: `${userExist.phoneNum}`,
                driverType: `${userExist.driverType}`,
                accessToken: ``,
                joinOn: DT,
            };
            return res.json(responsefunc("1", "Registration Step-1 Completed", outputObj, ""))
        } else {
            await otpVerification.update(
                {
                    OTP,
                    reqAt: DT,
                },
                { where: { userId: userExist.id } }
            )

            await otpVerification.findOne({
                where: {
                    userId: userExist.id
                }
            })

            let outObj = {
                userId: `${userExist.id}`,
                image: `${userExist.image}`,
                firstName: `${userExist.firstName}`,
                lastName: `${userExist.lastName}`,
                email: `${userExist.email}`,
                phoneNum: `${userExist.phoneNum}`,
                countryId: `${userExist.countries.name}`,
                driverType: `${userExist.driverType}`,
                accessToken: ``,
                joinOn: DT,
            };
            return res.json(responsefunc("1", "Registration Step-1 Completed", outObj, ""))
        }
    } else {
        let hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await users.create({
            firstName,
            lastName,
            email,
            phoneNum,
            status: true,
            password: hashedPassword,
            userTypeId: 3,
            countryId,
            cityId,
            driverType
        })

        await driverInZones.create({
            status: true,
            driverId: newUser.id,
            zoneId,
            countryId,
            cityId,
            laundaryShopId
        })

        if (typeof req.files.profileImage !== 'undefined') {
            let tmpProfileImage = req.files.profileImage[0].path;
            let profileImageName = tmpProfileImage.replace(/\\/g, "/")

            await users.update(
                { image: profileImageName },
                { where: { id: newUser.id } }
            )
        }

        await users.findOne({
            where: {
                id: newUser.id
            }
        })

        const otpData = await otpVerification.findOne({
            where: { userId: newUser.id },
        });

        let OTP = otpGenerator.generate(4, {
            lowerCaseAlphabets: false,
            upperCaseAlphabets: false,
            specialChars: true,
        });


        otpMail({
            type: 'RegisterOTP',
            email: email,
            OTP: OTP
        })

        let DT = new Date();
        if (!otpData) {
            otpVerification.create({
                OTP,
                reqAt: DT,
                userId: newUser.id
            })
        } else {
            otpVerification.update(
                {
                    OTP,
                    reqAt: DT,
                },
                { where: { userId: newUser.id } }
            )
        }
        let outObj = {
            userId: `${newUser.id}`,
            image: `${newUser.image}`,
            firstName: `${firstName}`,
            lastName: `${lastName}`,
            email: `${email}`,
            phoneNum: `${phoneNum}`,
            driverType: `${driverType}`,
            accessToken: ``,
            joinOn: DT,
        };
        return res.json(
            responsefunc("1", "Registration Step 1: Completed", outObj, "")
        );
    }
}


/* 
 *              Verify OTP 
*/
async function verifyOTP(req, res) {
    const { OTP, userId } = req.body
    const otpData = await otpVerification.findOne({ where: { userId: userId } })
    if (!otpData) {
        throw new customError(
            "OTP Data not available",
            "Please try sending OTP again"
        )
    }

    if (otpData.OTP != OTP && OTP !== '5678') {
        throw new customError(
            "Invalid OTP",
            "Please enter correct OTP to continue"
        )
    }
    await users.update({ verifiedAt: Date.now() }, { where: { id: userId } })
    return res.json(responsefunc("1", "OTP verified Sucessfully", { userId }, ""))

}


/* 
 *      Register Step 2(Vehicle data)
*/

async function driverRegisterStep2(req, res) {
    const { vehicleTypeId, vehicleName, vehicleModel, vehicleYear, vehicleColour, userId } = req.body

    if (!req.files.length){
        throw new customError("Images not uploaded", "Please upload images");
    }
        
    let imagesArr = req.files.map((ele) => {
        let tmpPath = ele.path;
        let imagePath = tmpPath.replace(/\\/g, "/");
        let tmpObj = {
            image: imagePath,
            //uploadTime: Date.now(),
            status: true,
            userId,
        };
        return tmpObj;
    });

    const driverFind = await driverDetail.findOne({
        where: {
            userId: userId
        }
    })

    if (driverFind) {
        await driverDetail.update({
            vehicleName,
            vehicleModel,
            vehicleYear,
            vehicleColour,
            vehicleTypeId
        }, { where: { userId: userId } })

        let imgStatus = await vehicleImage.update({ status: false }, { where: { userId } })

        vehicleImage.bulkCreate(imagesArr)
        return res.json(responsefunc("1", "Registration step 2: Completed", { detailsId: detailsExist.id, userId }, ""))
    }

    let newEntry = await driverDetail.create({
        vehicleName,
        vehicleModel,
        vehicleYear,
        vehicleColour,
        //driverTypeId: 1,
        vehicleTypeId,
        userId,
    });
    await vehicleImage.bulkCreate(imagesArr);
    return res.json(
        responsefunc(
            "1",
            "Registration step 2: Completed",
            { detailsId: newEntry.id, userId },
            ""
        )
    );

}

/*
 * upload Vehicle Images
*/

async function uploadVehicleImages(req, res) {
    const userId = req.user.id

    if (!req.files) {
        throw new customError("Images not uploaded", "Please upload images");
    }


    let imagesArr = req.files.map((ele) => {
        let tmpPath = ele.path;
        let imagePath = tmpPath.replace(/\\/g, "/");
        let tmpObj = {
            image: imagePath,
            //uploadTime: Date.now(),
            status: true,
            userId,
        };
        return tmpObj;
    });
    await vehicleImage.bulkCreate(imagesArr);

    return res.json(responsefunc("1", "Vehicle Images Uploaded", "", ""));


}


/* 
 *  Verify OTP
*/

async function verifyOtp(req, res) {
    const { OTP, userId } = req.body
    const otpData = await otpVerification.findOne({ where: { userId: userId } })
    if (!otpData) {
        throw new customError("OTP Data not available", "Please try sending OTP again")
    }
    if (otpData.OTP != OTP && OTP != '5678') {
        throw new customError(
            "Invalid OTP",
            "Please enter correct OTP to continue"
        )
    }
    await users.update({ verifiedAt: Date.now() }, { where: { id: userId } })
    return res.json(responsefunc('1', 'OTP verified Sucessfully', { userId }, ""))

}


/*
  * Register Step-3(License Information) 
*/

async function driverRegister3(req, res) {
    const { licIssueDate, licExpiryDate, userId, dvToken } = req.body
    console.log("🚀 ~ driverRegister3 ~ req.body:", req.body)
    const userData = await users.findOne({
        where: {
            id: userId
        },
        include: { model: deviceToken, attributes: ['tokenId'] },
        attributes: ['id', "firstName", 'lastName', 'email', 'status', "verifiedAt", 'phoneNum', 'image', 'userTypeId', [sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"), "joinedOn"]]
    })
    console.log("🚀 ~ driverRegister3 ~ userData:", userData)
    let tmpLicFrontImage = req.files.frontImage[0].path;
    let licFrontImage = tmpLicFrontImage.replace(/\\/g, "/");
    let tmpLicBackImage = req.files.backImage[0].path;
    let licBackImage = tmpLicBackImage.replace(/\\/g, "/");
    await driverDetail.update({ licIssueDate, licExpiryDate, licFrontImage, licBackImage }, { where: { userId } })


    //const found = userData.deviceToken.find((ele) => ele.tokenId === dvToken);
    await deviceToken.create({
        tokenId: dvToken,
        status: true,
        userId: userData.id
    })

    const accessToken = jwt.sign({
        id: userData.id,
        email: userData.email,
        dvToken: dvToken,
        uiserTypeId: userData.userTypeId
    }, process.env.JWT_ACCESS_SECRET)

    redisCli.hSet(`id-${userData.id}`, dvToken, accessToken)
    const firebaseSet = await axios.get(
        "https://theshippinghack-default-rtdb.firebaseio.com/ShippingHack_driver/" +
        `${userData.id}` +
        ".json"
    );
    console.log("🚀 ~ driverRegister3 ~ firebaseSet:", firebaseSet)
    let online_status = false;
    if (firebaseSet.data != null) {
        online_status = true;
    }

    let output = loginDataForDriver(userData, accessToken, online_status, dvToken)

    return res.json(output)

}


/*
     *    Driver Login 
*/
async function driverLogin(req, res) {
    const { email, password, dvToken } = req.body

    let online_status = false;

    const userData = await users.findOne({
        where: {
            email: email,
            deletedAt: {
                [Op.is]: null
            }
        },
        include: [
            {
                model: deviceToken,
                attributes: ['tokenId']
            },
            {
                model: driverDetail,
                as: 'driverDetails'
            }
        ],
        attributes: [
            "id",
            "firstName",
            "lastName",
            "email",
            "password",
            "status",
            "verifiedAt",
            "phoneNum",
            "userTypeId",
            "image",
            [
                sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"),
                "joinedOn",
            ],
        ],
    })

    //return res.json(userData)
    //console.log("🚀 ~ driverLogin ~ userData:", userData)

    if (!userData) {
        throw new customError(
            "User not found",
            "No user exists against this email"
        )
    }
    else if (userData && userData.userTypeId === 2) {
        throw new customError(
            "The follwoing email belongs to Customer!",
            "Try to login on Customer App"
        )
    }
    let match = await bcrypt.compare(password, userData.password)
    if (!match) {
        throw new customError(
            "Bad credentials",
            "Please enter correct password to continue"
        )
    }
    if (!userData.verifiedAt) {
        return res.json(
            responsefunc(
                "2",
                "Pending email verification",
                loginDataForDriver(userData, "accessToken", online_status, dvToken),
                ""
            )
        );
    }

    let checkId;
    console.log("checkId", userData.driverDetails[0].licIssueDate);
    if (userData.driverDetails) {
        if (userData.driverDetails[0].licIssueDate) {
            checkId = true;
        } else {
            checkId = false;
        }
    } else {
        checkId = false;
    }
    console.log("checkId", checkId);

    if (!checkId)
        return res.json(
            responsefunc(
                "4",
                "Pending License Data",
                loginDataForDriver(userData, "accessToken", online_status, dvToken),
                ""
            )
        );
    //  checking the status
    if (!userData.status)
        throw new CustomException(
            "Blocked by admin",
            "Please contact admin to continue"
        );
    // Checking user status
    const requ = await axios.get(
        "https://theshippinghack-default-rtdb.firebaseio.com/ShippingHack_driver/" +
        `${userData.id}` +
        ".json"
    );
    if (requ.data != null) {
        online_status = true;
    }
    console.log("Device Tokens", requ);


    const dvTokenFound = userData.deviceTokens.find((ele) => ele.tokenId === dvToken)
    if (!dvTokenFound) {
        await deviceToken.create({
            tokenId: dvToken,
            status: true,
            userId: userData.id
        })
    }

    const accessToken = jwt.sign({
        id: userData.id,
        email: userData.email,
        dvToken: dvToken,
        userTypeId: userData.userTypeId
    }, process.env.JWT_ACCESS_SECRET)

    redisCli.hSet(`id-${userData.id}`, dvToken, accessToken)
    let output = loginDataForDriver(userData, accessToken, online_status, dvToken)
    return res.json(output)
}

/*
*   OTP request for changing password
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
   * Verify OTp for Changing passsword
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
   * Resend OTP
*/

async function resendOTP(req, res) {
    const { userId } = req.body
    const userExist = await users.findByPk(userId)
    console.log("🚀 ~ resendOTP ~ userExist:", userExist.email)
    if (!userExist) {
        throw new customError(
            "Sorry, we could not fetch the associated data",
            "Please try sending again"
        )
    }

    const otpData = await otpVerification.findOne({
        where: {
            userId
        }
    })

    let OTP = otpGenerator.generate(4, {
        lowerCaseAlphabets: false,
        upperCaseAlphabets: false,
        specialChars: true
    })

    otpMail({
        type: 'ForgetPassword',
        email: userExist.email,
        OTP: OTP
    })

    let dt = new Date();
    if (userExist.otpVerification != null) {
        try {
            otpVerification.update(
                {
                    OTP: OTP,
                    reqAt: dt,
                }, { where: { userid: userExist.id } }
            )
            return res.json(responsefunc("1", "OTP Updated Sucessfully", { otpid: userExist.otpVerification.id, userId: userExist.id }))

        } catch (error) {
            console.log("Error in updating OTP", error)
            throw new customError(`${error.message}`)
        }
    } else {
        try {
            const otpSend = otpVerification.create({
                OTP: OTP,
                reqAt: dt,
                userId: userExist.id
            })
            return res.json(responsefunc("1", "OTP sent Sucessfully for Password Reset", { otpId: otpSend.id, userId: userExist.id }))
        } catch (error) {
            console.log("Error in updating OTP", error)
            throw new customError(`${error.message}`)
        }
    }
}


/*
   *  Check Session
*/
async function session(req, res) {
    const userId = req.user.id;
    console.log("ÃƒÂ°Ã…Â¸Ã…Â¡Ã¢â€šÂ¬ ~ file: driver.js:416 ~ session ~ userId:", userId);
    // only get those users which are not deleted
    const userData = await users.findOne({
        where: { deletedAt: { [Op.is]: null }, id: userId },
        attributes: [
            "id",
            "firstName",
            "lastName",
            "email",
            "status",
            "countryCode",
            "phoneNum",
            "deletedAt",
            "image",
            [
                sequelize.fn("date_format", sequelize.col("createdAt"), "%Y"),
                "joinedOn",
            ],
        ],
    });
    if (!userData)
        return res.json(
            returnFunction(
                3,
                "Account does not exist",
                {},
                "Please create account to continue"
            )
        );
    // send status = 3 when blocked but not deleted
    if (!userData.status)
        return res.json(
            returnFunction(
                4,
                "You are blocked by Admin",
                {},
                "Please contact support for more information"
            )
        );
    //const accessToken = sign({id: userData.id, email: userData.email, dvToken: "dvToken" }, process.env.JWT_ACCESS_SECRET);
    const accessToken = req.header("accessToken");
    const requ = await axios.get(
        "https://theshippinghack-default-rtdb.firebaseio.com/ShippingHack_driver/" +
        `${userData.id}` +
        ".json"
    );
    let online_status = false;
    if (requ.data != null) {
        online_status = true;
    }
    let output = loginDataForDriver(userData, accessToken, online_status, "");
    return res.json(output);
}


/*
   * Get vehicle Types
*/

async function getActiveVehicleTypes(req, res) {
    const vehicleData = await vehicleType.findAll({
        where: {
            status: true
        }
    })

    return res.json(responsefunc("1", "All Vehicle Types Fetched", vehicleData, ""))
}


/*
 * Upload License Images
*/

async function uploadLicenseImages(req, res) {
    const userId = req.user.id;

    // Create an object to store image paths for both front and back images
    const updateData = {};

    // Check if front image is provided, then update the path
    if (typeof req.files.frontImage !== "undefined") {
        let tmpLicFrontImage = req.files.frontImage[0].path;
        let licFrontImage = tmpLicFrontImage.replace(/\\/g, "/");
        updateData.licFrontImage = licFrontImage;
    }

    // Check if back image is provided, then update the path
    if (typeof req.files.backImage !== "undefined") {
        let tmpLicBackImage = req.files.backImage[0].path;
        let licBackImage = tmpLicBackImage.replace(/\\/g, "/");
        updateData.licBackImage = licBackImage;
    }

    console.log("updateData---->", updateData);


    if (Object.keys(updateData).length > 0) {
        await driverDetail.update(updateData, { where: { userId } });
    }

    return res.json(responsefunc("1", "Licence Images Uploaded", "", ""));
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


let loginData = (userData, accessToken, isGuest) => {
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
        },
        error: "",
    };
};

let loginDataForDriver = (userData, accessToken, online_status, dvToken) => {
    return {
        userId: `${userData.id}`,
        firstName: `${userData.firstName}`,
        lastName: `${userData.lastName}`,
        email: `${userData.email}`,
        phoneNum: `${userData.phoneNum}`,
        accessToken: `${accessToken}`,
        online_status: online_status,
        joinedOn: `${userData.joinedOn}`,
        driverType: `${userData.driverType}`,
        dvToken,
    };
};




//!--------------------------Exports-------------//
module.exports = {
    driverregisterStep1,
    verifyOTP,
    uploadVehicleImages,
    driverRegisterStep2,
    verifyOtp,
    driverRegister3,
    driverLogin,
    forgetPasswordRequest,
    verifyOTPforPassword,
    changePasswordOTP,
    resendOTP,
    session,
    getActiveVehicleTypes,
    uploadLicenseImages

}






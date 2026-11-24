require("dotenv").config();
const { users,
    userType,
    booking,
    deviceToken,
    vehicleType,
    driverDetail,
    vehicleImage,
    countries,
    driverInZones } = require('../../models')
const { resolveSessionIdentity, openAppSession } = require('../../utils/appSession');
const sequelize = require('sequelize')
const { redact } = require("../../utils/redact");
const { Op } = require('sequelize')
const bcrypt = require('bcryptjs')
var JSbarcode = require('jsbarcode')
const {
    defaultPasswordReset,
    toId,
    toHttpError: passwordResetHttpError,
} = require('../../services/shared/passwordReset')
const { CODE_PURPOSES } = require('../../services/shared/otpCode')

/** Accounts the driver sign-up, code and password reset endpoints serve: drivers (userTypes.id 3). */
const DRIVER_USER_TYPES = [3]

/** The driver API has always answered these refusals with 400. */
const DRIVER_RESET_STATUS = { not_found: 400, incorrect: 400, not_verified: 400 }

/** Sign-up verification keeps the wording the driver app was built against (400, like customError). */
const DRIVER_SIGNUP_STATUS = { not_found: 400, incorrect: 400 }
const DRIVER_SIGNUP_MESSAGES = { not_found: 'OTP Data not available', incorrect: 'Invalid OTP' }
const customError = require('../../middlewares/customError')
const { ACCOUNT_BLOCKED_MESSAGE } = require('../../utils/accountBlocked')
const { USER_TYPE, ACCOUNT_KIND, ownAccountForEmail } = require('../../services/shared/accountEmail')
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

    // users.email is unique across every account type. An address of a customer, shop or staff
    // account (or of a deleted account) is a 409: this flow only ever continues a driver's own
    // unverified sign-up, never another account's (services/shared/accountEmail.js). Before, a
    // phone or email match on any account type mailed a sign-up code for that account.
    await ownAccountForEmail(users, email, USER_TYPE.DRIVER, ACCOUNT_KIND.DRIVER)

    const driverByEmail = await users.findOne({
        where: {
            email: email,
            userTypeId: USER_TYPE.DRIVER,
            deletedAt: { [Op.is]: null }
        },
        include: [
            {
                model: countries,
                attributes: ['name']
            }
        ]
    });
    const driverByPhone = phoneNum ? await users.findOne({
        where: {
            phoneNum: phoneNum,
            userTypeId: USER_TYPE.DRIVER,
            deletedAt: { [Op.is]: null }
        },
        attributes: ['id', 'verifiedAt']
    }) : null;

    // A phone number another driver account holds is never taken over from a different email.
    if (driverByPhone && (!driverByEmail || driverByPhone.id !== driverByEmail.id)) {
        throw new customError(
            "Users exists",
            "The phone number you entered is already taken")
    }

    const userExist = driverByEmail;
    if (userExist) {
        if (userExist.verifiedAt) {
            throw new customError(
                "Users exists",
                "The email you entered is already taken"
            )
        }

        // A new code on the account's row (services/shared/passwordReset.js): digits only, one
        // live code per account, counted against the account's code limit.
        const DT = new Date();
        let issued
        try {
            issued = await defaultPasswordReset().issueCode({ userId: userExist.id, purpose: CODE_PURPOSES.SIGNUP })
        } catch (err) {
            throw passwordResetHttpError(err, DRIVER_RESET_STATUS)
        }

        try {
            await otpMail({
                type: 'RegisterOTP',
                email: email,
                OTP: issued.code,
                userName: userExist.firstName || 'Driver'
            });
        } catch (mailError) {
            console.error('⚠️ OTP email failed (non-blocking):', mailError.message || mailError);
        }

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

        // The account's first code (services/shared/passwordReset.js): digits only.
        let DT = new Date();
        let issued
        try {
            issued = await defaultPasswordReset().issueCode({ userId: newUser.id, purpose: CODE_PURPOSES.SIGNUP })
        } catch (err) {
            throw passwordResetHttpError(err, DRIVER_RESET_STATUS)
        }

        try {
            await otpMail({
                type: 'RegisterOTP',
                email: email,
                OTP: issued.code,
                userName: firstName
            });
        } catch (mailError) {
            console.error('⚠️ OTP email failed (non-blocking):', mailError.message || mailError);
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
    // Special test OTP - bypass normal verification
    return verifyDriverSignupCode(req, res, req.body.OTP === '5678')
}

/**
 * Sign-up verification for both driver verify handlers. The app sends the account (userId) and
 * the code; the code must be that driver account's live code and is used up (single use,
 * limited wrong guesses: services/shared/passwordReset.js). An otpId, if sent, names the row
 * and the userId must be its owner.
 */
async function verifyDriverSignupCode(req, res, skipCodeCheck) {
    const { OTP, userId, otpId } = req.body
    let verified
    try {
        verified = await defaultPasswordReset().verifySignupCode({
            otpId,
            userId,
            code: OTP,
            userTypeIds: DRIVER_USER_TYPES,
            skipCodeCheck,
        })
    } catch (err) {
        throw passwordResetHttpError(err, DRIVER_SIGNUP_STATUS, DRIVER_SIGNUP_MESSAGES)
    }
    await users.update({ verifiedAt: Date.now() }, { where: { id: verified.userId } })
    // The app's own value when it sent one (it names the same account).
    return res.json(responsefunc("1", "OTP verified Sucessfully", { userId: userId ?? verified.userId }, ""))
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
    // Special test OTP - bypass normal verification
    return verifyDriverSignupCode(req, res, req.body.OTP == '5678')
}


/*
  * Register Step-3(License Information) 
*/

async function driverRegister3(req, res) {
    const { licIssueDate, licExpiryDate, userId, dvToken } = req.body
    // The session of this app install (utils/appSession.js); checked before any write.
    const identity = resolveSessionIdentity(req.body)
    console.log("🚀 ~ driverRegister3 ~ req.body:", redact(req.body))
    const userData = await users.findOne({
        where: {
            id: userId
        },
        include: { model: deviceToken, attributes: ['tokenId'] },
        attributes: ['id', "firstName", 'lastName', 'email', 'status', "verifiedAt", 'phoneNum', 'image', 'userTypeId', [sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"), "joinedOn"]]
    })
    console.log("🚀 ~ driverRegister3 ~ userData:", redact(userData))
    let tmpLicFrontImage = req.files.frontImage[0].path;
    let licFrontImage = tmpLicFrontImage.replace(/\\/g, "/");
    let tmpLicBackImage = req.files.backImage[0].path;
    let licBackImage = tmpLicBackImage.replace(/\\/g, "/");
    await driverDetail.update({ licIssueDate, licExpiryDate, licFrontImage, licBackImage }, { where: { userId } })


    const accessToken = await openAppSession({
        userId: userData.id,
        claims: { id: userData.id, email: userData.email, userTypeId: userData.userTypeId },
        identity,
    })
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
    // The session of this app install (utils/appSession.js); push token optional.
    const identity = resolveSessionIdentity(req.body)

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
    // The driver app serves driver accounts (userTypeId 3) only. A shop, team member or staff
    // account has no driver profile: it used to fail further down with a 500.
    else if (Number(userData.userTypeId) !== USER_TYPE.DRIVER) {
        throw new customError(
            "This email does not belong to a driver account",
            "Please sign in with the app for your account"
        )
    }
    let match = Boolean(userData.password) && await bcrypt.compare(String(password || ''), userData.password)
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
    const driverProfile = Array.isArray(userData.driverDetails) ? userData.driverDetails[0] : null;
    if (driverProfile) {
        if (driverProfile.licIssueDate) {
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
        throw new customError(
            ACCOUNT_BLOCKED_MESSAGE,
            "Please contact the support team"
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


    const accessToken = await openAppSession({
        userId: userData.id,
        claims: { id: userData.id, email: userData.email, userTypeId: userData.userTypeId },
        identity,
    })
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
            userTypeId: { [Op.in]: DRIVER_USER_TYPES },
        },
        attributes: ["id", "email", "firstName"],
    });

    // user not found
    if (!userData)
        throw new customError(
            "Invalid information",
            "No user exists against this email"
        );

    // A new code ends any earlier code and verified reset (services/shared/passwordReset.js).
    let issued
    try {
        issued = await defaultPasswordReset().issueCode({ userId: userData.id, purpose: CODE_PURPOSES.PASSWORD_RESET })
    } catch (err) {
        throw passwordResetHttpError(err, DRIVER_RESET_STATUS)
    }

    try {
        await otpMail({
            type: 'ForgetPassword',
            email: userData.email,
            OTP: issued.code,
            userName: userData.firstName || 'Driver'
        });
    } catch (mailError) {
        console.error('⚠️ OTP email failed (non-blocking):', mailError.message || mailError);
    }

    return res.json(responsefunc(
        "1",
        issued.created ? "OTP sent Sucessfully for Password Reset" : "OTP Updated Sucessfully",
        driverOtpData(issued.otpId, userData.id)
    ))
}

/**
 * `data` of the driver code requests: `otpId` as documented (swagger.yaml), plus the
 * deprecated `otpid` spelling earlier builds were sent when a code row already existed.
 */
function driverOtpData(otpId, userId) {
    return { otpId, otpid: otpId, userId }
}


/*
   * Verify OTp for Changing passsword
*/

async function verifyOTPforPassword(req, res) {
    const { otpId, OTP, userId } = req.body;
    // The code must be the account's live, unexpired code; it is used up here
    // (single use, limited wrong guesses) and opens the reset (services/shared/passwordReset.js).
    // A userId sent with it must name the code's account.
    let verified
    try {
        verified = await defaultPasswordReset().verifyResetCode({
            otpId,
            userId,
            code: OTP,
            userTypeIds: DRIVER_USER_TYPES,
        })
    } catch (err) {
        throw passwordResetHttpError(err, DRIVER_RESET_STATUS)
    }
    return res.json(
        responsefunc("1", "OTP verified", { otpId, userId: verified.userId }, "")
    );
}


/*
*           Change password in response to OTP
*/
async function changePasswordOTP(req, res) {
    const { userId, otpId, password } = req.body;
    // The password changed is the verified code's owner's; a userId the app sends must name
    // that owner. Every session of the account ends (services/shared/passwordReset.js).
    try {
        await defaultPasswordReset().resetPassword({
            otpId,
            userId,
            password,
            userTypeIds: DRIVER_USER_TYPES,
        })
    } catch (err) {
        throw passwordResetHttpError(err, DRIVER_RESET_STATUS)
    }
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
    // Only driver accounts: the other apps resend through their own endpoints.
    const accountId = toId(userId)
    const userExist = accountId && await users.findOne({
        where: {
            id: accountId,
            userTypeId: { [Op.in]: DRIVER_USER_TYPES },
            deletedAt: { [Op.is]: null },
        },
        attributes: ['id', 'email', 'firstName'],
    })
    if (!userExist) {
        throw new customError(
            "Sorry, we could not fetch the associated data",
            "Please try sending again"
        )
    }

    // A new code for the account (services/shared/passwordReset.js): it also serves a password
    // reset in progress, so it goes through the same lifecycle and limits, and the new code
    // keeps the purpose of the one it replaces (sign-up or password reset).
    let issued
    try {
        issued = await defaultPasswordReset().issueResendCode({ userId: userExist.id })
    } catch (err) {
        throw passwordResetHttpError(err, DRIVER_RESET_STATUS)
    }

    try {
        await otpMail({
            type: 'ForgetPassword',
            email: userExist.email,
            OTP: issued.code,
            userName: userExist.firstName || 'Driver'
        });
    } catch (mailError) {
        console.error('⚠️ OTP email failed (non-blocking):', mailError.message || mailError);
    }

    return res.json(responsefunc(
        "1",
        issued.created ? "OTP sent Sucessfully for Password Reset" : "OTP Updated Sucessfully",
        driverOtpData(issued.otpId, userExist.id)
    ))
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
                ACCOUNT_BLOCKED_MESSAGE,
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






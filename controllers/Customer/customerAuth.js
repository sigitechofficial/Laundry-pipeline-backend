require("dotenv").config();
const { users, userType, booking, otpVerification, deviceToken, countries, cities } = require('../../models')
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
const customerAuthService = require('../../services/Customer/authService')
const guestAuthService = require('../../services/Customer/guestAuthService')
const ResponseHelper = require('../../utils/responseHelper')
const { ValidationError } = require('../../middlewares/universalErrorHandler')

//!-------------------Customer Auth---------------------//
/*
  * Combine Register with OTP
*/
async function registerCustomerWithOTP(req, res) {
    const { firstName, lastName, password, dvToken, phoneNum, confirmPassword, countryId, cityId, email, countryCode } = req.body;
    console.log("🚀 ~ registerCustomerWithOTP ~ req.body:", req.body);

    let profileImg = null;
    if (req.file) {
        let tempProfileImg = req.file.path;
        profileImg = tempProfileImg.replace(/\\/g, "/");
    }

    // Call service to handle business logic
    const result = await customerAuthService.registerCustomerWithOTP({
        firstName,
        lastName,
        password,
        dvToken,
        phoneNum,
        confirmPassword,
        countryId,
        cityId,
        email,
        countryCode
    }, profileImg);

    // Return response using ResponseHelper with legacy format for compatibility
    return ResponseHelper.success(res,"OTP sent successfully", result);
}





/*
   * verify OTp for SignUp
*/
async function verifyOTpSignUp(req, res) {
    const { otpId, OTP, userId, dvToken } = req.body;

    // Call service to handle business logic
    const result = await customerAuthService.verifyOTpSignUp({
        otpId,
        OTP,
        userId,
        dvToken
    });

    // Set cookie
    res.cookie("accessToken", result.accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: "None",
        path: "/customer",
        maxAge: 24 * 60 * 60 * 1000
    });

    // Generate response data using existing helper function
    let output = VerifyOTPData(result.userData, result.accessToken, result.isGuest);
    return res.json(output);
}

/*
 * Register Customer 
*/
async function registerCustomer(req, res) {
    const { firstName, lastName, password, dvToken, phoneNum, confirmPassword, userId, countryId, cityId } = req.body
    console.log("ðŸš€ ~ registerCustomer ~ req.body:", req.body)

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
    console.log("ðŸš€ ~ registerCustomer ~ userfind:", userfind)


    if (!userfind) {
        throw new customError("User Not Exists")
    }

    if (userfind.verifiedAt === null) {
        return res.json(responsefunc("2", "Please verify your OTP", {}, ""))
    }


    if (password !== confirmPassword) {
        throw new customError(" Passwords do not match. Please try again.")

    }

    const hashpass = await bcrypt.hash(password, 8)
    console.log("ðŸš€ ~ registerCustomer ~ hashpass:", hashpass)

    const stripeCustomer = await stripe.createStripeCustomer(userfind.firstName, userfind.email)
    console.log("ðŸš€ ~ registerCustomer ~ stripeCustomer:", stripeCustomer)

    await users.update({
        firstName,
        lastName,
        status: true,
        password: hashpass,
        dvToken,
        phoneNum,
        stripeCustomerId: stripeCustomer,
        image: profileImg,
        cityId,
        countryId
    }, {
        where: { id: userfind.id }
    })

    const updatedUser = await users.findOne({
        where: {
            id: userfind.id
        },
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
        ]
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

    if (dvToken) {
        await redisCli.hSet(
            `id-${userfind.id}`,
            { [dvToken]: accessToken }
        )
    }


    let outputObj = registerData(updatedUser, accessToken, false)

    return res.json(outputObj)

}



/*
    *  Login User
*/
async function loginUser(req, res) {
    const {
        email,
        password,
        signedFrom,
        dvToken,
        firstName,
        lastName,
        phoneNum,
        lat,
        lng,
        guestUser,
        isGuest,
    } = req.body;

    // Call service to handle business logic
    const result = await customerAuthService.loginUser({
        email,
        password,
        signedFrom,
        dvToken,
        firstName,
        lastName,
        phoneNum,
        lat,
        lng,
        guestUser,
        isGuest,
    });

    // Handle success case
    if (result.type === 'success') {
        // Handle social signup case (no access token)
        if (result.socialSignup) {
            return ResponseHelper.success(res, result.message, result.data);
        }

        // Set cookie for regular login
        if (result.accessToken) {
            const maxAgeMs = result.expiresInSeconds
                ? result.expiresInSeconds * 1000
                : 24 * 60 * 60 * 1000;
            res.cookie("accessToken", result.accessToken, {
                httpOnly: true,
                secure: true,
                sameSite: "None",
                path: "/customer",
                maxAge: maxAgeMs,
            });

            // Generate response data using existing helper function
            let output = loginData(result.userData, result.accessToken, result.isGuest, result.zoneId, result.zoneName);
            if (result.isGuest) {
                output.message = "Guest session started";
            }
            return res.json(output);
        }
    }
}


/*
*   Forget Password
*/
async function forgetPasswordRequest(req, res) {
    const { email } = req.body;

    // Call service to handle business logic
    const result = await customerAuthService.forgetPasswordRequest({
        email
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, {
        otpId: result.otpId,
        userId: result.userId
    });
}


/*
   *       Verify OTP for changing password
*/
async function verifyOTPforPassword(req, res) {
    const { otpId, OTP } = req.body;

    // Call service to handle business logic
    const result = await customerAuthService.verifyOTPforPassword({
        otpId,
        OTP
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, {
        otpId: result.otpId,
        userId: result.userId
    });
}

/*
*           Change password in response to OTP
*/
async function changePasswordOTP(req, res) {
    const { userId, otpId, password } = req.body;

    // Call service to handle business logic
    const result = await customerAuthService.changePasswordOTP({
        userId,
        otpId,
        password
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, {});
}



/* 
   * Resend OTP
*/
async function resendOTP(req, res) {
    const { userId } = req.body;

    // Call service to handle business logic
    const result = await customerAuthService.resendOTP({
        userId
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, {
        otpId: result.otpId
    });
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

    // Call service to handle business logic
    const result = await customerAuthService.session({
        userId,
        guestUser
    });

    // Generate response data using existing helper function
    let output = loginData(result.userData, result.accessToken, result.isGuest);
    return res.json(output);
}

/*
 * Guest (no DB user): JWT + Redis session — separate from registered customer auth.
 */
async function startGuestSession(req, res) {
    const result = await guestAuthService.startGuestSession();
    res.cookie("accessToken", result.accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: "None",
        path: "/customer",
        maxAge: result.expiresInSeconds * 1000,
    });
    const output = loginData(
        result.userData,
        result.accessToken,
        true,
        null,
        null
    );
    output.message = "Guest session started";
    return res.json(output);
}

async function guestSession(req, res) {
    const stub = guestAuthService.guestUserStub();
    const output = loginData(stub, "", true, null, null);
    output.message = "Login successful";
    return res.json(output);
}

async function guestLogout(req, res) {
    try {
        await guestAuthService.destroyGuestSession(req.user.jti);
        return res.json({
            status: "1",
            message: "Log-out successfully",
            data: {},
            error: "",
        });
    } catch (err) {
        return res.json({
            status: "0",
            message: "Internal server error",
            data: {},
            error: "There is some error logging out. Please try again",
        });
    }
}



/*
   * Get User profile
*/

async function getUserProfile(req, res) {
    const userId = req.user.id;

    // Call service to handle business logic
    const result = await customerAuthService.getUserProfile({
        userId
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, result.userData);
}



/*
  *  Update User profile
*/

async function updateUserProfile(req, res) {
    const userId = req.user.id;
    const { firstName, lastName, email, isProfileImgChanged, phoneNum, countryCode } = req.body;

    let profileImage = null;
    if (isProfileImgChanged === "true") {
        if (!req.file) {
            throw new ValidationError("Profile Image Required");
        } else {
            let tempProfileImg = req.file.path;
            profileImage = tempProfileImg.replace(/\\/g, "/");
        }
    }

    // Call service to handle business logic
    const result = await customerAuthService.updateUserProfile({
        userId,
        firstName,
        lastName,
        email,
        isProfileImgChanged,
        phoneNum,
        countryCode
    }, profileImage);

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, {});
}

//!------------------------------------------Recurring functions----------------------------------------//
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
        statusCode: 200,
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


let loginData = (userData, accessToken, isGuest, zoneId = null, zoneName = null) => {
    return {
        status: "1",
        message: "Login successful",
        statusCode: 200,
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
            stripeCustomerId: `${userData.stripeCustomerId}`,
            zoneId: zoneId ?? null,
            zoneName: zoneName ?? null,
        },
        error: "",
    };
};


let VerifyOTPData = (userData, accessToken, isGuest) => {
    return {
        status: "1",
        message: "OTP Verified successfully",
        statusCode: 200,
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
                : "2025",
            phoneNum: `${userData.phoneNum}`,
            stripeCustomerId: `${userData.stripeCustomerId}`,
        },
        error: "",
    };
};





//!--------------------------Exports------------------------------------//

module.exports = {
    registerCustomerWithOTP,
    verifyOTpSignUp,
    registerCustomer,
    loginUser,
    forgetPasswordRequest,
    verifyOTPforPassword,
    changePasswordOTP,
    logout,
    getUserProfile,
    updateUserProfile,
    session,
    resendOTP,
    startGuestSession,
    guestSession,
    guestLogout,
}
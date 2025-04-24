require("dotenv").config();
const { users,
    userType,
    booking,
    otpVerification,
    deviceToken,
    vehicleType,
    countries,
    cities,
    zone } = require('../../models')
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
const {
    currentAppUnitsId,
    unitsConversion,
    unitsSymbolsAndRates,
    convertToBaseUnits,
} = require('../../utils/unitsManagement');
const { type } = require("os");




//!-------------------------Admin SignIn-----------------------------------------//
/*
 *        Admin SignIn
*/

async function signIn(req, res) {
    const { email, password, dvToken } = req.body;

    // Find the admin data based on email, status, and classifiedAId
    const adminData = await users.findOne({
        where: {
            email,
            status: true,
            userTypeId: 1
        },
    });

    console.log("🚀 ~ signIn ~ adminData:", adminData);

    if (!adminData) {
        throw new customError("User not found", "Please enter valid data");
    }

    const match = await bcrypt.compare(password, adminData.password);
    if (!match) {
        throw new customError(
            "Bad credentials",
            "Please enter the correct password to continue"
        );
    }

    if (dvToken) {
        await users.update({ dvToken }, { where: { id: adminData.id } });
    }



    const payload = {
        id: adminData.id,
        email: adminData.email,
        dvToken: dvToken,
    };


    const accessToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET);

    // Add the admin's online clients to the Redis database
    redisCli.hSet(`tsh${adminData.id}`, dvToken, accessToken);


    const output = {
        id: adminData.id,
        name: adminData.name,
        email: adminData.email,
        accessToken,
        userName: adminData.companyName,
        //featureData: featureData
    };

    res.cookie("accessToken", accessToken, {
        //   httpOnly: true,
        //   secure: true, 
        //   sameSite: "None",
          path: "/admin",
          maxAge: 24 * 60 * 60 * 1000
        });
        

    return res.json(responsefunc("1", "Login Successful", output, ""));
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


module.exports = {
    signIn
}
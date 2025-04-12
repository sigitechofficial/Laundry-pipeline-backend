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
    addressDb,
cities } = require('../../models')
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




/*
   * Get Laundary Shops
*/

async function getLaundaryShops(req,res) {

    const getShopAddress=await addressDb.findAll({
        where:{
            addressType:'laundaryShop'
        },
        include:[{
            model:countries,
            attributes:['name']
        },{
            model:cities,
            attributes:['name']
        }],
        attributes:['title','customAddressTitle','streetAddress','district','province','lat','lng','status','radius','addressType','coordinates']
    })


    return res.json(responsefunc("1","All Laundary Shops Fetched",getShopAddress,""))
    
}



//!----------------------------------------Driver Jobs Controllers---------------------------------------//
async function driverBooking(req,res) {
    
}





















//!------------------------Recurring Functions------------------//
let responsefunc = (status, message, data, error) => {
    return {
        status: `${status}`,
        messsage: `${message}`,
        data: data,
        error: `${error}`

    }
}


//!--------------------------Expoorts------------------//
module.exports={
    getLaundaryShops
}
const express=require('express')
const router =express()
const customerAuthControllers=require('../controllers/Customer/customerAuth')
const customerOtherController=require('../controllers/Customer/customerOrders')
const asyncMiddleware=require('../middlewares/asyncHandler')
const multer=require('multer')
const path=require('path')
const validateAccessToken=require('../middlewares/accessToken')
const { route } = require('./driver')

//!Multer Middlewares
const uploadProfilePic=multer.diskStorage({
    destination:(req,file,cb)=>{
        cb(null,'./Public/Profile')

    },
    filename:(req,file,cb)=>{
        cb(null,'profile- '+ req?.user?.id + "- "+ Date.now() + path.extname(file.originalname))
    }
})

const uploadProfile=multer({
    storage:uploadProfilePic
})





//!---------------------------------Modeule Authentication and Authorization----------------------------//
//complete registration of customer
router.post('/registerCustomer',uploadProfile.single('profileImage'),asyncMiddleware(customerAuthControllers.registerCustomerWithOTP))
//verify otp for registration
router.post('/verifyOTpSignUp',asyncMiddleware(customerAuthControllers.verifyOTpSignUp))
//User login
router.post('/loginUser',asyncMiddleware(customerAuthControllers.loginUser))
//forgot password request through otp send to mail
router.post('/forgetPasswordRequest',asyncMiddleware(customerAuthControllers.forgetPasswordRequest))
//Verify OTP to change password
router.post('/verifyOTPforPassword',asyncMiddleware(customerAuthControllers.verifyOTPforPassword))
//Change Password
router.post('/changePasswordOTP',asyncMiddleware(customerAuthControllers.changePasswordOTP))
//logout user and destroy the Token in redis
router.get('/logout',validateAccessToken,asyncMiddleware(customerAuthControllers.logout))
//Session Api
router.get("/session",validateAccessToken, asyncMiddleware(customerAuthControllers.session))
//Resend OTP
router.post('/resendOTP',validateAccessToken,asyncMiddleware(customerAuthControllers.resendOTP))
//!------------------------------------Drawer-------------------------------//
//get Profile
router.get('/getUserProfile',validateAccessToken,asyncMiddleware(customerAuthControllers.getUserProfile));
//Update Customer Profile
router.patch("/updateUserProfile",validateAccessToken,uploadProfile.single('profileImage'),asyncMiddleware(customerAuthControllers.updateUserProfile))
//Customer Addresses
router.get('/customerAddresses',validateAccessToken,asyncMiddleware(customerOtherController.customerAddresses))
//!------------------------------Customer Booking--------------------------//
//create Booking
router.post('/createBooking',validateAccessToken,asyncMiddleware(customerOtherController.createBooking))
//Customer All Bookings
router.get('/allBookings',validateAccessToken,asyncMiddleware(customerOtherController.allBookings))
//Customer Specific Booking
router.get('/bookingDetailsById',validateAccessToken,asyncMiddleware(customerOtherController.bookingDetailsById))
//Custome Response Update and Evemt Sent To Agent
router.patch('/customerResponseUpdate',validateAccessToken,asyncMiddleware(customerOtherController.customerResponseUpdate))

//!------------------------------ Customer OnHold Show--------------------------//
//on Hold Customer Reason Show
router.get('/onHoldCustomerShow',validateAccessToken,asyncMiddleware(customerOtherController.onHoldCustomerShow))
//on Hold Customer Update
router.patch('/customerUpdateResponse',validateAccessToken,asyncMiddleware(customerOtherController.customerUpdateResponse))
//!----------------------------Customer Services---------------------//
//get All Services
router.get('/allServices',validateAccessToken,asyncMiddleware(customerOtherController.allServices))
//Get Specific Service Detail
router.get('/serviceDetail/:serviceId',validateAccessToken,asyncMiddleware(customerOtherController.serviceDetail))
//Get Preferences
router.get('/getPrefrencesValues',validateAccessToken,asyncMiddleware(customerOtherController.getPrefrencesValues))
//Get Intent 
router.get('/updateBookingUpfrontAmount',validateAccessToken,asyncMiddleware(customerOtherController.updateBookingUpfrontAmount))
module.exports=router
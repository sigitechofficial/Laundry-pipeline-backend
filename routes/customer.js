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
router.post('/resendOTP',asyncMiddleware(customerAuthControllers.resendOTP))
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
router.get('/serviceDetail',asyncMiddleware(customerOtherController.serviceDetail))
//Get Preferences
router.get('/getPrefrencesValues',validateAccessToken,asyncMiddleware(customerOtherController.getAllServiceWithPreferenceDetails))
//Get Intent 
router.get('/updateBookingUpfrontAmount',validateAccessToken,asyncMiddleware(customerOtherController.updateBookingUpfrontAmount))
//fetch Zone and Charges
router.get('/fetchZoneAndCharges',validateAccessToken,asyncMiddleware(customerOtherController.fetchZoneAndCharges))
//Create Intent Using Stripe
router.post('/createIntentUsingStripe',validateAccessToken,asyncMiddleware(customerOtherController.createIntentUsingStripe))
// Route to get all on-hold bookings for a given booking ID
router.get('/getOnHoldBookings/:bookingId', validateAccessToken,asyncMiddleware(customerOtherController.getOnHoldBookings));
// Route to update customer response for on-hold booking
router.patch('/updateCustomerResponseForOnHoldBooking', validateAccessToken,asyncMiddleware(customerOtherController.updateCustomerResponseForOnHoldBooking));
// Route to get all bookings with on-hold status for a specific customer
router.get('/getOnHoldBookingsForCustomer', validateAccessToken, asyncMiddleware(customerOtherController.getOnHoldBookingsForCustomer));
// Route to test sending notifications
router.post('/testNotification', validateAccessToken, asyncMiddleware(customerOtherController.testNotification));
// Route to test sending emails (uses otpMail with full template)
router.post('/testEmail', asyncMiddleware(customerOtherController.testEmail));
// Route to test sending emails directly via ZeptoMail API (simple test)
router.post('/testEmailAPI', asyncMiddleware(customerOtherController.testEmailAPI));
// Route to get all service with preference details
router.get('/getAllServiceWithPreferenceDetails/:serviceId', validateAccessToken, asyncMiddleware(customerOtherController.getAllServiceWithPreferenceDetails));
//Get All Order Status
router.get('/getAllOrderStatus', validateAccessToken, asyncMiddleware(customerOtherController.getAllOrderStatus));
//Cancel Customer Booking with Policy Enforcement
router.post('/cancelBooking', validateAccessToken, asyncMiddleware(customerOtherController.cancelCustomerBooking));
//Get Customer Cancellation History
router.get('/cancellationHistory', validateAccessToken, asyncMiddleware(customerOtherController.getCustomerCancellationHistory));
//Get Active Policies (cancellation, reschedule, no-show)
router.get('/getActivePolicies', validateAccessToken, asyncMiddleware(customerOtherController.getActivePolicies));

//!----------------------------Customer Postcode Address Lookup---------------------//
//Get addresses by UK postcode
router.get('/postcode/:postcode', validateAccessToken, asyncMiddleware(customerOtherController.getAddressesByPostcode));
//Get specific address by postcode and index
router.get('/postcode/:postcode/address/:index', validateAccessToken, asyncMiddleware(customerOtherController.getAddressById));
//Validate UK postcode format
router.post('/postcode/validate', validateAccessToken, asyncMiddleware(customerOtherController.validatePostcode));

module.exports=router
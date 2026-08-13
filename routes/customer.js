const express=require('express')
const router =express()
const customerAuthControllers=require('../controllers/Customer/customerAuth')
const customerOtherController=require('../controllers/Customer/customerOrders')
const customerPaymentMethodsController=require('../controllers/Customer/customerPaymentMethods')
const shopReviewController=require('../controllers/Customer/shopReviewController')
const adminController=require('../controllers/Admin/admin')
const asyncMiddleware=require('../middlewares/asyncHandler')
const multer=require('multer')
const path=require('path')
const validateAccessToken=require('../middlewares/accessToken')
const validateGuestAccessToken=require('../middlewares/guestAccessToken')
const validateAccessTokenOrGuest=require('../middlewares/accessTokenOrGuest')
const {
    postcodeAutocompleteRateLimit,
    postcodeValidateRateLimit,
} = require('../middlewares/postcodeRateLimit')
const { route } = require('./driver')
const { createDestinationDirectory } = require('../utils/destination')

//!Multer Middlewares
const uploadProfilePic=multer.diskStorage({
    destination:(req,file,cb)=>{
        createDestinationDirectory('./Public/Profile', cb)
    },
    filename:(req,file,cb)=>{
        cb(null,'profile- '+ req?.user?.id + "- "+ Date.now() + path.extname(file.originalname))
    }
})

const uploadProfile=multer({
    storage:uploadProfilePic
})

const uploadRepairImageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        createDestinationDirectory('./Public/repairImages', cb)
    },
    filename: (req, file, cb) => {
        cb(
            null,
            `repair-${req?.user?.id || 'guest'}-${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(file.originalname)}`
        )
    },
})

const uploadRepairImages = multer({
    storage: uploadRepairImageStorage,
    limits: { fileSize: 8 * 1024 * 1024, files: 5 },
    fileFilter: (req, file, cb) => {
        const mime = String(file.mimetype || '').toLowerCase()
        const ext = path.extname(file.originalname || '').toLowerCase()
        const imageExts = new Set([
            '.jpg',
            '.jpeg',
            '.png',
            '.webp',
            '.gif',
            '.heic',
            '.heif',
        ])
        const isImageMime = mime.startsWith('image/')
        // GetConnect defaults MultipartFile contentType to application/octet-stream
        const isLikelyImageBinary =
            (mime === 'application/octet-stream' || !mime) &&
            (imageExts.has(ext) || !ext)
        if (!isImageMime && !isLikelyImageBinary) {
            return cb(new Error('Only image uploads are allowed'))
        }
        cb(null, true)
    },
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
// Delete own customer account
router.post('/deleteAccount',validateAccessToken,asyncMiddleware(customerAuthControllers.deleteAccount))
//Session Api (registered customer or guest JWT)
router.get("/session", validateAccessTokenOrGuest, asyncMiddleware(customerAuthControllers.session))
// Guest (no DB row): JWT + Redis — does not use validateAccessToken / users table
router.post('/guest/start', asyncMiddleware(customerAuthControllers.startGuestSession))
router.get('/guest/session', validateGuestAccessToken, asyncMiddleware(customerAuthControllers.guestSession))
router.get('/guest/logout', validateGuestAccessToken, asyncMiddleware(customerAuthControllers.guestLogout))
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
//Customer detailed track order timeline
router.get('/trackOrder',validateAccessToken,asyncMiddleware(customerOtherController.trackOrder))
// Live map tracking bootstrap (Firebase RTDB custom token)
const liveTrackingController = require('../controllers/liveTrackingController')
router.get('/live-tracking/:bookingId',validateAccessToken,asyncMiddleware(liveTrackingController.getCustomerLiveTracking))
//Custome Response Update and Evemt Sent To Agent
router.patch('/customerResponseUpdate',validateAccessToken,asyncMiddleware(customerOtherController.customerResponseUpdate))

//!------------------------------ Customer OnHold Show--------------------------//
//on Hold Customer Reason Show
router.get('/onHoldCustomerShow',validateAccessToken,asyncMiddleware(customerOtherController.onHoldCustomerShow))
//on Hold Customer Update
router.patch('/customerUpdateResponse',validateAccessToken,asyncMiddleware(customerOtherController.customerUpdateResponse))
//!----------------------------Customer Services---------------------//
//get All Services
router.get('/allServices',asyncMiddleware(customerOtherController.allServices))
//Get Specific Service Detail (registered or guest)
router.get('/serviceDetail',asyncMiddleware(customerOtherController.serviceDetail))
// Public support contact (email, phone, help URL, hours) — from DB
router.get('/supportContact', asyncMiddleware(async (req, res) => {
    req.query.audience = req.query.audience || 'customer';
    return adminController.getSupportContact(req, res);
}))
router.get('/accountDeletionReasons', asyncMiddleware(customerOtherController.getAccountDeletionReasons))

//!----------------------------Shop Reviews---------------------//
router.get('/reviewReasonCodes', asyncMiddleware(shopReviewController.getReviewReasonCodes))
router.get('/pendingShopReviews', validateAccessToken, asyncMiddleware(shopReviewController.getPendingShopReviews))
router.get('/bookings/:bookingId/reviewEligibility', validateAccessToken, asyncMiddleware(shopReviewController.getReviewEligibility))
router.post('/shopReviews', validateAccessToken, asyncMiddleware(shopReviewController.createShopReview))
router.get('/shops/:businessInfoId/reviews', asyncMiddleware(shopReviewController.getShopReviews))

//Get Preferences
router.get('/getPrefrencesValues',validateAccessToken,asyncMiddleware(customerOtherController.getAllServiceWithPreferenceDetails))
//Get Intent 
router.get('/updateBookingUpfrontAmount',validateAccessToken,asyncMiddleware(customerOtherController.updateBookingUpfrontAmount))
//fetch Zone and Charges (registered or guest)
router.get('/fetchZoneAndCharges',validateAccessTokenOrGuest,asyncMiddleware(customerOtherController.fetchZoneAndCharges))
router.get('/bookingSlots',validateAccessTokenOrGuest,asyncMiddleware(customerOtherController.getBookingSlots))
//Create Intent Using Stripe
router.post('/createIntentUsingStripe',validateAccessToken,asyncMiddleware(customerOtherController.createIntentUsingStripe))

//!----------------------------Payment Methods (saved cards)---------------------//
// List all cards (multiple shown; one isDefault / active)
router.get(
    '/payment-methods',
    validateAccessToken,
    asyncMiddleware(customerPaymentMethodsController.listPaymentMethods)
);
// SetupIntent clientSecret for adding a new card (no charge)
router.post(
    '/payment-methods/setup-intent',
    validateAccessToken,
    asyncMiddleware(customerPaymentMethodsController.createPaymentMethodSetupIntent)
);
// After SetupIntent confirm: attach + Option A set as active + sync open bookings
router.post(
    '/payment-methods',
    validateAccessToken,
    asyncMiddleware(customerPaymentMethodsController.addAndActivatePaymentMethod)
);
// Switch active card among saved cards
router.patch(
    '/payment-methods/default',
    validateAccessToken,
    asyncMiddleware(customerPaymentMethodsController.setDefaultPaymentMethod)
);
// Remove a saved card (if active, another becomes active if any remain)
router.delete(
    '/payment-methods/:paymentMethodId',
    validateAccessToken,
    asyncMiddleware(customerPaymentMethodsController.removePaymentMethod)
);
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
// Route to get all service with preference details (registered or guest)
router.get('/getAllServiceWithPreferenceDetails/:serviceId', validateAccessTokenOrGuest, asyncMiddleware(customerOtherController.getAllServiceWithPreferenceDetails));
// Repair / alteration catalog for a service
router.get('/repairCatalog/:serviceId', validateAccessTokenOrGuest, asyncMiddleware(customerOtherController.getRepairCatalog));
// Upload repair garment photos
router.post(
    '/uploadRepairImages',
    validateAccessToken,
    uploadRepairImages.array('images', 5),
    asyncMiddleware(customerOtherController.uploadRepairImages)
);
//Get All Order Status
router.get('/getAllOrderStatus', validateAccessToken, asyncMiddleware(customerOtherController.getAllOrderStatus));
//Cancel Customer Booking with Policy Enforcement
router.post('/cancelBooking', validateAccessToken, asyncMiddleware(customerOtherController.cancelCustomerBooking));
//Get Customer Cancellation History
router.get('/cancellationHistory', validateAccessToken, asyncMiddleware(customerOtherController.getCustomerCancellationHistory));
//Get Active Policies (cancellation, reschedule, no-show)
router.get('/getActivePolicies', validateAccessToken, asyncMiddleware(customerOtherController.getActivePolicies));
//Reschedule Customer Booking with Policy Enforcement
router.post('/rescheduleBooking', validateAccessToken, asyncMiddleware(customerOtherController.rescheduleCustomerBooking));
//Get Customer Reschedule History
router.get('/rescheduleHistory', validateAccessToken, asyncMiddleware(customerOtherController.getCustomerRescheduleHistory));

//!----------------------------Home Screen Config---------------------//
//Get home screen config (delivery, min order, service fee, no-show fee)
router.get('/getHomeConfig', validateAccessToken, asyncMiddleware(customerOtherController.getHomeConfig))

//!----------------------------Coupon---------------------//
//Validate and apply a coupon code (returns discount amount and final total)
router.post('/applyCoupon', validateAccessToken, asyncMiddleware(customerOtherController.applyCoupon))

//!----------------------------Banners---------------------//
//Get active banners for customer (optionally filter by zoneId or showOnHome)
router.get('/getBanners', asyncMiddleware(customerOtherController.getActiveBanners))

//!----------------------------Customer Postcode Address Lookup---------------------//
// Free postcode suggestions (postcodes.io)
router.get(
    '/postcode/autocomplete',
    validateAccessTokenOrGuest,
    postcodeAutocompleteRateLimit,
    asyncMiddleware(customerOtherController.autocompletePostcode)
);
// Free postcode verify (postcodes.io)
router.post(
    '/postcode/validate',
    validateAccessTokenOrGuest,
    postcodeValidateRateLimit,
    asyncMiddleware(customerOtherController.validatePostcode)
);
// Paid address list (Ideal Postcodes) — must be after /autocomplete
router.get(
    '/postcode/:postcode/address/:index',
    validateAccessTokenOrGuest,
    asyncMiddleware(customerOtherController.getAddressById)
);
router.get(
    '/postcode/:postcode',
    validateAccessTokenOrGuest,
    asyncMiddleware(customerOtherController.getAddressesByPostcode)
);

module.exports=router
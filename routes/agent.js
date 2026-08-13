const express = require("express");
const router = express();
//const agentAuthController = require("../controllers/Agent/agentAuth");
const agentAuthController = require("../controllers/Agent/authController");
const agentController = require("../controllers/Agent/agents");
const bookingAttemptController = require("../controllers/Agent/bookingAttemptController");
const shopReviewAgentController = require("../controllers/Agent/shopReviewController");
const adminController = require("../controllers/Admin/admin");
const asyncMiddleware = require("../middlewares/asyncHandler");
const checkPermissions = require("../middlewares/checkPermission");
const multer = require("multer");
const path = require("path");
const validateAccessToken = require("../middlewares/accessToken");
const {
    requireShopOwner,
    requireCapability,
    requireAnyCapability,
    requireBookingAssignee,
} = require("../middlewares/requireShopOwner");
const {
    postcodeAutocompleteRateLimit,
    postcodeValidateRateLimit,
} = require("../middlewares/postcodeRateLimit");
const { access } = require("fs");
const { route } = require("./driver");
const { DATE } = require("sequelize");
const { createDestinationDirectory } = require("../utils/destination");

//!--------------------------------------------------------Multer Middlewares---------------------------------------------------------//
//for profile Picture
const uploadProfilePic = multer.diskStorage({
    destination: (req, file, cb) => {
        const destinationPath = "./Public/Profile";
        createDestinationDirectory(destinationPath, cb);
    },
    filename: (req, file, cb) => {
        cb(
            null,
            "profile- " +
            req?.user?.id +
            "- " +
            Date.now() +
            path.extname(file.originalname)
        );
    },
});

const uploadProfile = multer({
    storage: uploadProfilePic,
});

//For Driver pickup and delivery picture proofs
const uploadProofsImg = multer.diskStorage({
    destination: (req, file, cb) => {
        const destinationPath = "./Public/driverProofs";
        createDestinationDirectory(destinationPath, cb);
    },
    filename: (req, file, cb) => {
        cb(
            null,
            "proofImg-" +
            req?.user?.id +
            "-" +
            Date.now() +
            path.extname(file.originalname)
        );
    },
});

const uploadPickDropProofs = multer({
    storage: uploadProofsImg,
});

//For Agent on Hold Image Upload
const onHoldImage = multer.diskStorage({
    destination: (req, file, cb) => {
        const destinationPath = "./Public/onHoldImages";

        createDestinationDirectory(destinationPath, cb);
    },
    filename: (req, file, cb) => {
        cb(
            null,
            "onHoldImg-" +
            req?.user?.id +
            "-" +
            Date.now() +
            path.extname(file.originalname)
        );
    },
});

const uploadonHoldImages = multer({
    storage: onHoldImage,
});

//!-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------//

//!---------------------------------------------------------------------------Auth Module-------------------------------------------------------------------------------------//
//complete registration of Agent
router.post(
    "/registerAgent",
    uploadProfile.single("profileImage"),
    asyncMiddleware(agentAuthController.registerAgentWithOTP)
);

//verify otp for registration
router.post(
    "/verifyOTpSignUp",
    asyncMiddleware(agentAuthController.verifyOTpSignUp)
);

//Resend OTP
router.post("/resendotp", asyncMiddleware(agentAuthController.resendOTP));
//User login
router.post("/loginUser", asyncMiddleware(agentAuthController.loginUser));
//Agent Employee login
router.post("/employeeLogin", asyncMiddleware(agentAuthController.employeeLogin));
//Agent Employee logout
router.get("/employeeLogout", validateAccessToken, asyncMiddleware(agentAuthController.employeeLogout));
//forgot password request through otp send to mail
router.post(
    "/forgetPasswordRequest",
    asyncMiddleware(agentAuthController.forgetPasswordRequest)
);
//Verify OTP to change password
router.post(
    "/verifyOTPforPassword",
    asyncMiddleware(agentAuthController.verifyOTPforPassword)
);
//Change Password
router.post(
    "/changePasswordOTP",
    asyncMiddleware(agentAuthController.changePasswordOTP)
);
//logout user and destroy the Token in redis
router.get(
    "/logout",
    validateAccessToken,
    asyncMiddleware(agentAuthController.logout)
);

//Delete agent account and all related data
router.delete(
    "/deleteAccount",
    validateAccessToken,
    asyncMiddleware(agentAuthController.deleteAccount)
);

//Agent Sesion Api
router.post(
    "/session",
    validateAccessToken,
    asyncMiddleware(agentAuthController.session)
);

//Agent Bussiness Information
router.post(
    "/addBusinessInfor",
    asyncMiddleware(agentAuthController.agentBusinessInfo)
);

// Generate Stripe Onboarding Link - GET with query params, no auth required
router.get(
    "/generateStripeOnboardingLink",
    asyncMiddleware(agentAuthController.generateStripeOnboardingLink)
);

//!-----------------------------------------------------------Drawer-----------------------------------------------------------------------//
//get Profile
router.get(
    "/getUserProfile",
    validateAccessToken,
    asyncMiddleware(agentAuthController.getUserProfile)
);
//Update Customer Profile
router.patch(
    "/updateUserProfile",
    validateAccessToken,
    uploadProfile.single("profileImage"),
    asyncMiddleware(agentAuthController.updateUserProfile)
);

//!-------------------------------------------------------------Agent Address Module---------------------------------------------------//
router.post(
    "/agentAddressAdd",
    asyncMiddleware(agentController.agentAddressAdd)
);
router.patch(
    "/agentAddressEdit",
    validateAccessToken,
    asyncMiddleware(agentController.agentAddressEdit)
);
router.get(
    "/getAgentAddress",
    validateAccessToken,
    asyncMiddleware(agentController.getAgentAddress)
);

router.get(
    "/getBookingHome",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.getBookingHome)
);

//!------------------------------------------------------Agent Booking Api's-----------------------------------------------//
//Get Order for Agent
router.get(
    "/getAgentOrder",
    validateAccessToken,
    asyncMiddleware(agentController.getAgentOrder)
);
//Agent Accept Order
router.post(
    "/acceptOrder",
    validateAccessToken,
    requireCapability("canAcceptOrders"),
    asyncMiddleware(agentController.agentAcceptOrder)
);
//Agent reject/decline incoming booking (hidden from this agent only)
router.post(
    "/rejectOrder",
    validateAccessToken,
    requireCapability("canAcceptOrders"),
    checkPermissions,
    asyncMiddleware(agentController.agentRejectOrder)
);
// //Get Invoice Details for Agent
// router.get('/agentInvoiceMake',validateAccessToken,asyncMiddleware(agentController.orderDetailsforInvoice))
//Get All Services
router.get("/getAllServices", asyncMiddleware(adminController.getAllServices));
// Agent/admin support contact (zone-aware). Call button uses this — not customer phone.
router.get("/supportContact", validateAccessToken, asyncMiddleware(async (req, res) => {
    req.query.audience = "agent";
    return adminController.getSupportContact(req, res);
}));
//Agent upload proof Images
router.post(
    "/AddPickupDeliveryProof",
    validateAccessToken,
    checkPermissions,
    uploadPickDropProofs.array("Images", 10),
    requireBookingAssignee({ types: ["either"] }),
    asyncMiddleware(agentController.AddPickupDeliveryProof)
);
//Agent goes to pick order Byself and Mark order on the way driver
router.patch(
    "/agentBookingStatusOnTheWay/:bookingId",
    validateAccessToken,
    checkPermissions,
    requireBookingAssignee({ types: ["pickup"] }),
    asyncMiddleware(agentController.agentBookingStatusOnTheWay)
);
//Agent mark booking Status Arrived
router.patch(
    "/driverStatusArrived/:bookingId",
    validateAccessToken,
    checkPermissions,
    requireBookingAssignee({ types: ["pickup"] }),
    asyncMiddleware(agentController.driverStatusArrived)
);
// Live map tracking publisher bootstrap (Firebase RTDB custom token)
const liveTrackingController = require("../controllers/liveTrackingController");
router.get(
    "/live-tracking/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(liveTrackingController.getAgentLiveTracking)
);
router.post(
    "/live-tracking/:bookingId/demo-stream",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(liveTrackingController.startDemoLiveTrackingStream)
);
router.delete(
    "/live-tracking/:bookingId/demo-stream",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(liveTrackingController.stopDemoLiveTrackingStream)
);
// Pickup/delivery attempt options after Arrived (grace, fail, unattended)
router.get(
    "/booking/:bookingId/attempt-options",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(bookingAttemptController.getAttemptOptions)
);
router.post(
    "/booking/:bookingId/attempt/fail",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(bookingAttemptController.markAttemptFailed)
);
router.post(
    "/booking/:bookingId/attempt/reschedule",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(bookingAttemptController.rescheduleAfterFail)
);
router.post(
    "/booking/:bookingId/attempt/unattended",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(bookingAttemptController.markAttemptUnattended)
);
//Agent boooking status update picking and inspeection
router.patch(
    "/agentInspectionStatus/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.agentInspectionStatus)
);
//Agent Added the categories and items to make the Invoice
router.post(
    "/AgentAddSerivces",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.driverAddSerivces)
);
//Order Details of Specific Order
router.get(
    "/orderDetailsById",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.orderDetailsById)
);
//Driver made delivery to the Laundry Shop
router.patch(
    "/reachedAtDeliveryShopStatus/:bookingId",
    validateAccessToken,
    checkPermissions,
    requireBookingAssignee({ types: ["pickup"] }),
    asyncMiddleware(agentController.reachedAtDeliveryShopStatus)
);
//Laundry Washed At Laundry Shop
router.patch(
    "/laundryWashCompleted/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.laundryWashCompleted)
);
//Driver out deliver Laundry to Customer
router.patch(
    "/laundryDeliverToCustomer/:bookingId",
    validateAccessToken,
    checkPermissions,
    requireBookingAssignee({ types: ["delivery"] }),
    asyncMiddleware(agentController.laundryDeliverToCustomer)
);
//Invoice Details of Order
router.get(
    "/invoiceCreation/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.invoiceCreation)
);
//Booking Details on the Basis of the filters
router.get(
    "/agentBookingFilters",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.agentBookingFilters)
);
// Lightweight tab badge counts only (no list data)
router.get(
    "/bookingCounts",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.getBookingCounts)
);
// Agent past orders — active, completed, cancelled, on hold
router.get(
    "/order-history",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.getAgentOrderHistory)
);
//Set Order To On Hold
router.patch(
    "/onHoldConformation",
    validateAccessToken,
    checkPermissions,
    uploadonHoldImages.fields([{ name: "onHoldImg", maxCount: 50 }]),
    asyncMiddleware(agentController.onHoldConformation)
);
//Agent Set onHold Order issue to resolved
router.patch(
    "/agentIssueResolved/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.agentIssueResolved)
);
//Agent reached to deliver Laundry to customer
router.patch(
    "/driverReachedForDelivery/:bookingId",
    validateAccessToken,
    checkPermissions,
    requireBookingAssignee({ types: ["delivery"] }),
    asyncMiddleware(agentController.driverReachedForDelivery)
);
//Driver/Agent deliver delivery to customer
router.patch(
    "/bookingDeliverToCustomer/:bookingId",
    validateAccessToken,
    checkPermissions,
    requireBookingAssignee({ types: ["delivery"] }),
    asyncMiddleware(agentController.bookingDeliverToCustomer)
);
//invoice Details Tab Api
router.get(
    "/invoiceDetailTab",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.invoiceDetailTab)
);
// Save invoice as draft (no customer notification)
router.post(
    "/invoice/save-draft",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.saveInvoiceDraft)
);
// Get saved invoice draft
router.get(
    "/invoice/draft/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.getInvoiceDraft)
);
// Update existing invoice draft (sync by line id)
router.patch(
    "/invoice/update-draft",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.updateInvoiceDraft)
);

//Invoice Generate Status
router.patch(
    "/bookingInvoiceGeneratedStatusUpdated/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.bookingInvoiceGeneratedStatusUpdated)
);
//Update Invoice
router.patch(
    "/updateInvoice",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.updateInvoice)
);
//Update Invoice OnHold Status
router.patch(
    "/agentUpdateInvoice",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.agentUpdateInvoice)
);
//!--------------------------------------------------------Agent Cancel Booking-----------------------------------------------------------//
//Agent Calcel Booking
router.post(
    "/agentCancelBooking",
    validateAccessToken,
    asyncMiddleware(agentController.agentCancelBooking)
);
//!----------------------------------------------------------Agent Driver--------------------------------------------------------------//
// Get All Agent Drivers
router.get(
    "/agnetDrivers",
    validateAccessToken,
    asyncMiddleware(agentController.agnetDrivers)
);
// Unassign reasons for Return / Unassign me dialogs
router.get(
    "/staffUnassignReasons",
    validateAccessToken,
    requireAnyCapability(["canAssignStaff", "canRunAssignedJobs"]),
    asyncMiddleware(agentController.getStaffUnassignReasons)
);
//Agent Assign Order To Driver (legacy path — pickup assign, no forced status 13)
router.patch(
    "/agentAssignBookingToLaundryDriver",
    validateAccessToken,
    requireCapability("canAssignStaff"),
    asyncMiddleware(agentController.agentAssignBookingToLaundryDriver)
);
// Assign pickup or delivery staff
router.patch(
    "/assignBookingStaff",
    validateAccessToken,
    requireCapability("canAssignStaff"),
    asyncMiddleware(agentController.assignBookingStaff)
);
// Unassign staff (return to shop owner).
// Assigners: any leg. Runners: only self-assigned leg (controller enforces).
router.patch(
    "/unassignBookingStaff",
    validateAccessToken,
    requireAnyCapability(["canAssignStaff", "canRunAssignedJobs"]),
    asyncMiddleware(agentController.unassignBookingStaff)
);
// Reassign staff
router.patch(
    "/reassignBookingStaff",
    validateAccessToken,
    requireCapability("canAssignStaff"),
    asyncMiddleware(agentController.reassignBookingStaff)
);
// Staff jobs monitor board (assigners see all; runners see own via controller)
router.get(
    "/staffJobs",
    validateAccessToken,
    requireAnyCapability(["canAssignStaff", "canRunAssignedJobs"]),
    asyncMiddleware(agentController.getStaffJobs)
);
//Agent Assign Order to Self
router.patch(
    "/agentPickupOrderBySelf",
    validateAccessToken,
    requireCapability("canAssignStaff"),
    asyncMiddleware(agentController.agentPickupOrderBySelf)
);
// Staff activity (assignment events + completed jobs).
// Drivers with canRunAssignedJobs may load this for self-only (controller forces employeeId).
router.get(
    "/staffActivity",
    validateAccessToken,
    requireAnyCapability(["canViewStaffActivity", "canRunAssignedJobs"]),
    asyncMiddleware(agentController.getStaffActivity)
);
// Auto-assign settings (owner only by default ceiling)
router.get(
    "/autoAssignSettings",
    validateAccessToken,
    requireCapability("canManageAutoAssign"),
    asyncMiddleware(agentController.getAutoAssignSettings)
);
router.put(
    "/autoAssignSettings",
    validateAccessToken,
    requireCapability("canManageAutoAssign"),
    asyncMiddleware(agentController.putAutoAssignSettings)
);
// Per-employee capability overrides
router.get(
    "/employeeCapabilities/:employeeId",
    validateAccessToken,
    requireCapability("canManageTeam"),
    asyncMiddleware(agentController.getEmployeeCapabilities)
);
router.put(
    "/employeeCapabilities/:employeeId",
    validateAccessToken,
    requireCapability("canManageTeam"),
    asyncMiddleware(agentController.putEmployeeCapabilities)
);
router.patch(
    "/employeeCapabilities/:employeeId",
    validateAccessToken,
    requireCapability("canManageTeam"),
    asyncMiddleware(agentController.putEmployeeCapabilities)
);
//!--------------------------------------------Agent Add,roles,classifiedAs------------------------------------------//
//Add Roles (owner only — system roles 6/8 must not be casually mutated)
router.post(
    "/AddLaundryRoles",
    validateAccessToken,
    requireShopOwner,
    asyncMiddleware(agentController.addRole)
);
//Update Roles
router.patch(
    "/updateRoles",
    validateAccessToken,
    requireShopOwner,
    asyncMiddleware(agentController.updateRoles)
);
//Get Roles
router.get(
    "/getAllRoles",
    validateAccessToken,
    asyncMiddleware(agentController.getAllRoles)
);
//Add ClassifiedAs
router.post(
    "/addClassifiedAs",
    validateAccessToken,
    requireShopOwner,
    asyncMiddleware(agentController.addClassifiedAs)
);
//Get ClassifiedAs
router.get(
    "/getClassifiedAs",
    validateAccessToken,
    asyncMiddleware(agentController.getClassifiedAs)
);
//Add Features
router.post(
    "/addfeatures",
    validateAccessToken,
    requireShopOwner,
    asyncMiddleware(agentController.addfeatures)
);
//Get Features
router.get(
    "/getFeatures",
    validateAccessToken,
    asyncMiddleware(agentController.getFeatures)
);
//!--------------------------------------------------Agent Add,Update Employees---------------------------------------//
//Add Employee
router.post(
    "/addEmployee",
    validateAccessToken,
    requireCapability("canManageTeam"),
    uploadProfile.single("profileImage"),
    asyncMiddleware(agentController.addEmployee)
);
//update Employee
router.patch(
    "/updateEmployee",
    validateAccessToken,
    requireCapability("canManageTeam"),
    checkPermissions,
    uploadProfile.single("profileImage"),
    asyncMiddleware(agentController.updateEmployee)
);
//update Employee Status
router.patch(
    "/updateEmployeeStatus",
    validateAccessToken,
    requireCapability("canManageTeam"),
    checkPermissions,
    asyncMiddleware(agentController.changeEmployeeStatus)
);
// Soft-delete employee
router.delete(
    "/deleteEmployee/:employeeId",
    validateAccessToken,
    requireCapability("canManageTeam"),
    asyncMiddleware(agentController.deleteEmployee)
);
//Get All Employees
router.get(
    "/getAllEmployees",
    validateAccessToken,
    requireCapability("canManageTeam"),
    checkPermissions,
    asyncMiddleware(agentController.getAllEmployees)
);
//!-------------------------------------------------Agent Services----------------------------------------------------//
//Get Agent Services
router.get(
    "/getAgentServices",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.getAgentServices)
);
//Services Deatils for Showing
router.get(
    "/serviceDetail",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.serviceDetail)
);
//Edit Service Status
router.patch(
    "/editServiceStatus",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.editServiceStatus)
);
//!-------------------------------------------------------Customer Selected Services--------------------------------------------------//
router.get(
    "/customerServices",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.customerServices)
);
//Get Active Policies (cancellation, reschedule, no-show)
router.get(
    "/getActivePolicies",
    validateAccessToken,
    asyncMiddleware(agentController.getActivePolicies)
);
//Get all add-on services (admin catalog) for agent app
router.get(
    "/getAllAddOnServices",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.getAllAddOnServices)
);
//Get Customer Services For Updating Invoice
router.get(
    "/getCustomerServicestoUpdateInvoice",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.getCustomerServicestoUpdateInvoice)
);
//!=======================================================Get countries && cities==================================================//
router.get("/getCountries", asyncMiddleware(agentController.getCountries));
router.get("/getCities", asyncMiddleware(agentController.getCities));

//!----------------------------------------------------------Bussiness Information----------------------------------------------//
router.get(
    "/getBussinessInforMation/:userId",
    asyncMiddleware(agentController.getBussinessInforMation)
);
router.get(
    "/getBussinessWrkinghours/:userId",
    asyncMiddleware(agentController.getBussinessWrkinghours)
);
//Bussiness services info Add
router.post(
    "/businesInfoAdded/:userId",
    asyncMiddleware(agentAuthController.businesInfoAdded)
);
//Update Working Hours
router.patch(
    "/workingHoursUpdate/:userId",
    asyncMiddleware(agentAuthController.workingHoursUpdate)
);
// Platform operational hours bounds for agent's shop country (read-only)
router.get(
    "/platformOperationalHours",
    validateAccessToken,
    asyncMiddleware(agentController.getAgentPlatformOperationalHours)
);
//!-----------------------------------------OnHold Api----------------------------------------------------------------------//
//Get On Hold Options
router.get(
    "/getOnHoldOptions",
    asyncMiddleware(agentController.getOnHoldOptions)
);
//Get Permissions
router.get("/getPermissions", asyncMiddleware(agentController.getPermissions));
//Get getCustomerServicesForOnHold
router.get(
    "/getCustomerServicesForOnHold/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.getCustomerServicesForOnHold)
);
//Get print label tags data (order quantity × unitCount per line)
router.get(
    "/printLabelData/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.printLabelData)
);
// Get rejectedServiceItems
router.get(
    "/rejectedServiceItems/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.rejectedServiceItems)
);
//!----------------------------------------------------------Stripe Intent Api----------------------------------------------------------//
router.patch(
    "/booking/:id/balance-payment-method",
    validateAccessToken,
    asyncMiddleware(agentController.setBalancePaymentMethod)
);
router.post(
    "/createIntentUsingStripeForAgent",
    validateAccessToken,
    asyncMiddleware(agentController.createIntentUsingStripeForAgent)
);
router.post(
    "/recordCashPayment",
    validateAccessToken,
    asyncMiddleware(agentController.recordCashPayment)
);
//!----------------------------------------------------------Performance Dashboard----------------------------------------------------------//
router.get(
    "/getPerformanceDashboard",
    validateAccessToken,
    asyncMiddleware(agentController.getPerformanceDashboard)
);
router.get(
    "/getOrderSummaryDashboard",
    validateAccessToken,
    asyncMiddleware(agentController.getOrderSummaryDashboard)
);
router.get(
    "/getShopPerformanceDashboard",
    validateAccessToken,
    asyncMiddleware(agentController.getShopPerformanceDashboard)
);
router.get(
    "/getEarningReportDashboard",
    validateAccessToken,
    asyncMiddleware(agentController.getEarningReportDashboard)
);
router.get(
    "/wallet",
    validateAccessToken,
    requireShopOwner,
    asyncMiddleware(agentController.getAgentWallet)
);
router.get(
    "/wallet/transactions",
    validateAccessToken,
    requireShopOwner,
    asyncMiddleware(agentController.getAgentWalletTransactions)
);
router.post(
    "/wallet/withdraw",
    validateAccessToken,
    requireShopOwner,
    asyncMiddleware(agentController.withdrawAgentWallet)
);
router.get(
    "/settlement",
    validateAccessToken,
    requireShopOwner,
    asyncMiddleware(agentController.getAgentSettlement)
);
router.post(
    "/cash-remittance",
    validateAccessToken,
    requireShopOwner,
    asyncMiddleware(agentController.submitCashRemittance)
);

//!----------------------------Agent Postcode Lookup---------------------//
router.get(
    '/postcode/autocomplete',
    validateAccessToken,
    postcodeAutocompleteRateLimit,
    asyncMiddleware(agentController.autocompletePostcode)
);
router.post(
    '/postcode/validate',
    validateAccessToken,
    postcodeValidateRateLimit,
    asyncMiddleware(agentController.validatePostcode)
);
router.get(
    '/postcode/:postcode/address/:index',
    validateAccessToken,
    asyncMiddleware(agentController.getAddressById)
);
router.get(
    '/postcode/:postcode',
    validateAccessToken,
    asyncMiddleware(agentController.getAddressesByPostcode)
);

//!----------------------------------------------------------Notification APIs----------------------------------------------------------//
// Twilio SMS to customer at pickup / delivery reached
router.post(
    "/bookings/:bookingId/notify-customer",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.notifyCustomer)
);

// Send notification to customer using booking ID
router.post(
    '/sendNotificationToCustomer',
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.sendNotificationToCustomer)
);

// Send notification to admin(s)
router.post(
    '/sendNotificationToAdmin',
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.sendNotificationToAdmin)
);

// Send notification to multiple recipients (customer and/or admin)
router.post(
    '/sendNotificationToMultiple',
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.sendNotificationToMultiple)
);

//!----------------------------Shop Reviews Summary---------------------//
router.get(
    '/shopReviews/summary',
    validateAccessToken,
    asyncMiddleware(shopReviewAgentController.getShopReviewSummary)
);

module.exports = router;

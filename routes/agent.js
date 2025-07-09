const express = require("express");
const router = express();
const agentAuthController = require("../controllers/Agent/agentAuth");
const agentController = require("../controllers/Agent/agents");
const adminController = require("../controllers/Admin/admin");
const asyncMiddleware = require("../middlewares/asyncHandler");
const checkPermissions = require("../middlewares/checkPermission");
const multer = require("multer");
const path = require("path");
const validateAccessToken = require("../middlewares/accessToken");
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

//Agent Sesion Api
router.get(
    "/session",
    validateAccessToken,
    asyncMiddleware(agentAuthController.session)
);

//Agent Bussiness Information
router.post(
    "/addBusinessInfor",
    asyncMiddleware(agentAuthController.agentBusinessInfo)
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
    asyncMiddleware(agentController.agentAcceptOrder)
);
// //Get Invoice Details for Agent
// router.get('/agentInvoiceMake',validateAccessToken,asyncMiddleware(agentController.orderDetailsforInvoice))
//Get All Services
router.get("/getAllServices", asyncMiddleware(adminController.getAllServices));
//Agent upload proof Images
router.post(
    "/AddPickupDeliveryProof",
    validateAccessToken,
    checkPermissions,
    uploadPickDropProofs.array("Images", 10),
    asyncMiddleware(agentController.AddPickupDeliveryProof)
);
//Agent goes to pick order Byself and Mark order on the way driver
router.patch(
    "/agentBookingStatusOnTheWay/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.agentBookingStatusOnTheWay)
);
//Agent mark booking Status Arrived
router.patch(
    "/driverStatusArrived/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.driverStatusArrived)
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
    asyncMiddleware(agentController.driverReachedForDelivery)
);
//Driver/Agent deliver delivery to customer
router.patch(
    "/bookingDeliverToCustomer/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.bookingDeliverToCustomer)
);
//invoice Details Tab Api
router.get(
    "/invoiceDetailTab",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.invoiceDetailTab)
);

//Invoice Generate Status
router.patch(
    "/bookingInvoiceGeneratedStatusUpdated/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.bookingInvoiceGeneratedStatusUpdated)
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
//Agent Assign Order To Driver
router.patch(
    "/agentAssignBookingToLaundryDriver",
    validateAccessToken,
    asyncMiddleware(agentController.agentAssignBookingToLaundryDriver)
);
//Agent Assign Order to Self
router.patch(
    "/agentPickupOrderBySelf",
    validateAccessToken,
    asyncMiddleware(agentController.agentPickupOrderBySelf)
);
//!--------------------------------------------Agent Add,roles,classifiedAs------------------------------------------//
//Add Roles
router.post(
    "/AddLaundryRoles",
    validateAccessToken,
    asyncMiddleware(agentController.addRole)
);
//Update Roles
router.patch(
    "/updateRoles",
    validateAccessToken,
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
    uploadProfile.single("profileImage"),
    asyncMiddleware(agentController.addEmployee)
);
//update Employee
router.patch(
    "/updateEmployee",
    validateAccessToken,
    checkPermissions,
    uploadProfile.single("profileImage"),
    asyncMiddleware(agentController.updateEmployee)
);
//update Employee Status
router.patch(
    "/updateEmployeeStatus",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.changeEmployeeStatus)
);
//Get All Employees
router.get(
    "/getAllEmployees",
    validateAccessToken,
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
// Get rejectedServiceItems
router.get(
    "/rejectedServiceItems/:bookingId",
    validateAccessToken,
    checkPermissions,
    asyncMiddleware(agentController.rejectedServiceItems)
);
//!----------------------------------------------------------Stripe Intent Api----------------------------------------------------------//
router.post(
    "/createIntentUsingStripeForAgent",
    validateAccessToken,
    asyncMiddleware(agentController.createIntentUsingStripeForAgent)
);
//!----------------------------------------------------------Performance Dashboard----------------------------------------------------------//
router.get(
    "/getPerformanceDashboard",
    validateAccessToken,
    asyncMiddleware(agentController.getPerformanceDashboard)
);
module.exports = router;

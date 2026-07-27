const express = require('express')
const router = express()
const asyncMiddleware = require('../middlewares/asyncHandler')
const adminController = require('../controllers/Admin/admin')
const adminAuth = require('../controllers/Admin/adminAuth')
const reportsController = require('../controllers/Admin/reports')
const multer = require('multer')
const path = require('path')
const validateAccessToken = require('../middlewares/adminValidateToken')
const checkPermission = require('../middlewares/checkPermission')
const { createDestinationDirectory } = require('../utils/destination')
const agentController = require("../controllers/Agent/agents");
const couponController = require('../controllers/Admin/couponController');
const bannerController = require('../controllers/Admin/bannerController');
const agentSettlementController = require('../controllers/Admin/agentSettlementController');
const notifyLogsController = require('../controllers/Admin/notifyLogsController');


//!-------------------------------------Multer Middlewares---------------------//
//upload Vehicle Type Image
const uploadVehicleType = multer.diskStorage({
    destination: (req, file, cb) => {
        const destinationPath = `./Public/Images/VehicleTypes`;

        createDestinationDirectory(destinationPath, cb)
    },
    filename: (req, file, cb) => {
        cb(null, 'vehicleImage-' + req.body.title + '-' + Date.now() + path.extname(file.originalname))
    }
})
const uploadVehicleTypeImage = multer({
    storage: uploadVehicleType,
});


//Upload Country Images
const uploadCountryflagImg = multer.diskStorage({
    destination: (req, file, cb) => {
        const destinationPath = `./Public/Images/CountryFlags`;
        createDestinationDirectory(destinationPath, cb)
    },
    filename: (req, file, cb) => {
        cb(null, 'flagImg-' + req.body.shortName + '-' + Date.now() + path.extname(file.originalname))
    }
})

const uploadFlagImg = multer({
    storage: uploadCountryflagImg,
})

//Category Image Multer
const uploadCategoryPic = multer.diskStorage({
    destination: (req, file, cb) => {
        const destinationPath = './Public/CategoryImages';
        // Call the function to create the destination directory
        createDestinationDirectory(destinationPath, cb);
    },
    filename: (req, file, cb) => {
        cb(null, `CategoriesImg-${Date.now()}${path.extname(file.originalname)}`);
    },
});

const uploadcategoryImage = multer({
    storage: uploadCategoryPic
})


//Service Image Multer
const uploadServicePic = multer.diskStorage({
    destination: (req, file, cb) => {
        const destinationPath = './Public/serviceImages';
        createDestinationDirectory(destinationPath, cb);
    },
    filename: (req, file, cb) => {
        cb(null, `ServiceImg-${Date.now()}${path.extname(file.originalname)}`);
    },
});

const uploadServiceImage = multer({
    storage: uploadServicePic
})

//Driver Profile Image Multer
const uploadDriverProfilePic = multer.diskStorage({
    destination: (req, file, cb) => {
        const destinationPath = './Public/Profile';
        createDestinationDirectory(destinationPath, cb);
    },
    filename: (req, file, cb) => {
        cb(null, `Driver-Profile${Date.now()}${path.extname(file.originalname)}`);
    },
});

const uploadDriverProfile = multer({
    storage: uploadDriverProfilePic
})

//Blog Image Multer
const uploadBlogPic = multer.diskStorage({
    destination: (req, file, cb) => {
        const destinationPath = './Public/BlogImages';
        createDestinationDirectory(destinationPath, cb);
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const random = Math.round(Math.random() * 1E9);
        cb(null, `BlogImg-${timestamp}-${random}${path.extname(file.originalname)}`);
    },
});

const uploadBlogImage = multer({
    storage: uploadBlogPic
});

// Multer for multiple description images
const uploadBlogDescriptionImages = multer({
    storage: uploadBlogPic
});

// Banner Image Multer
const uploadBannerPic = multer.diskStorage({
    destination: (req, file, cb) => {
        const destinationPath = './Public/BannerImages';
        createDestinationDirectory(destinationPath, cb);
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const random = Math.round(Math.random() * 1E9);
        cb(null, `BannerImg-${timestamp}-${random}${path.extname(file.originalname)}`);
    },
});

const uploadBannerImage = multer({
    storage: uploadBannerPic,
    limits: { fileSize: 5 * 1024 * 1024 },
});





//!----------------------------------------Auth Api's----------------------------------------------//

//Admin SignIn — public, no token needed
router.post('/adminSignIn', asyncMiddleware(adminAuth.signIn))

//Zone Admin SignIn — public, no token needed
router.post('/zoneAdminSignIn', asyncMiddleware(adminAuth.zoneAdminSignIn))

//Get All Reasons
router.get('/getAllReasons', asyncMiddleware(adminController.getAllReasons))
// Get All FAQs
router.get('/getAllFAQs', asyncMiddleware(adminController.getAllFAQs))
// Get All Cancellation Policies
router.get('/getCancellationPolicies', asyncMiddleware(adminController.getAllCancellationPoliciesController))
// Get All Blogs
router.get('/getAllBlogs', asyncMiddleware(adminController.getAllBlogs))
//Get Countries
router.get('/getCountries', asyncMiddleware(adminController.getCountries))
//Get Cities
router.get('/getCities', asyncMiddleware(adminController.getCities))
// Get Blog by ID
router.get('/getBlog/:blogId', asyncMiddleware(adminController.getBlogById))
// Get All Active Policies (cancellation, reschedule, no-show)
router.get('/getActivePolicies', asyncMiddleware(adminController.getActivePoliciesController))

// Auth + permission check on all routes below this line.
// Super admin (classifiedAsId = null) → always bypasses checkPermission, full access.
// Zone admin / employees → pass through if no featureId; blocked only when featureId is sent and they lack that permission.
router.use(validateAccessToken, checkPermission)

// Support contact config
router.get('/getSupportContact', asyncMiddleware(adminController.getSupportContact))
router.patch('/updateSupportContact', asyncMiddleware(adminController.updateSupportContact))

// Platform operational hours (all shops — outer bounds)
router.get(
    '/platformOperationalHours',
    asyncMiddleware(adminController.getPlatformOperationalHours)
)
router.patch(
    '/platformOperationalHours',
    asyncMiddleware(adminController.updatePlatformOperationalHours)
)

router.get(
    '/bookings/:bookingId/assignableShops',
    asyncMiddleware(adminController.getBookingAssignableShops)
)
router.patch(
    '/bookings/:bookingId/assignShop',
    asyncMiddleware(adminController.assignBookingToShop)
)

//Add vehicle
router.post('/addvehicle', uploadVehicleTypeImage.single('image'), asyncMiddleware(adminController.addVehicle))

//Add Countries
router.post('/addCountries', uploadFlagImg.single('flagImg'), asyncMiddleware(adminController.addCountries))

//Update Country
router.put('/updateCountry/:countryId', uploadFlagImg.single('flagImg'), asyncMiddleware(adminController.updateCountry))
//Delete Country (Soft Delete)
router.delete('/deleteCountry/:countryId', asyncMiddleware(adminController.deleteCountry))
//Add Cities
router.post('/addCities', asyncMiddleware(adminController.addCities))

//Get Cities by Country Id
router.get('/getCitiesByCountryId/:countryId', asyncMiddleware(adminController.getCitiesByCountryId))
//Update City
router.put('/updateCity/:cityId', asyncMiddleware(adminController.updateCity))
//Delete City (Soft Delete)
router.delete('/deleteCity/:cityId', asyncMiddleware(adminController.deleteCity))
//!---------------------------------------Zones-----------------------------------------//
//Add Zones
router.post('/addZone', asyncMiddleware(adminController.addZones))
//Add Zones by Postcodes
router.post('/addZoneByPostcodes', asyncMiddleware(adminController.addZonesByPostcodes))
//Validate if entered postcode belongs to London
router.post('/validateLondonPostcode', asyncMiddleware(adminController.validateLondonPostcode))
// Edit Zone by Postcodes (optionally send postcodes to regenerate polygon)
router.put('/editZoneByPostcodes/:zoneId', asyncMiddleware(adminController.editZoneByPostcodes))
// Get Zones
router.get('/getZones', asyncMiddleware(adminController.getZones))
// Get Zone By ID (optional columns query: ?columns=id,name,status)
router.get('/getZoneById/:zoneId', asyncMiddleware(adminController.getZoneById))
//Delete Zone
router.delete('/delete-zone', asyncMiddleware(adminController.deleteZone))
//Update Zone
router.patch('/updateZone/:zoneId', asyncMiddleware(adminController.updateZone))
//!---------------------------------------Units-----------------------------------------//
//Get Units
router.get('/getUnitsDistanceAndCurrency', asyncMiddleware(adminController.getUnitsDistanceAndCurrency))
//Get All Units
router.get('/getAllUnits', asyncMiddleware(adminController.getAllUnits))
//!---------------------------------------Services,Categories,SubCategories-----------------------------------------//
//Create Service 
router.post("/AddServices", uploadServiceImage.single('serviceImg'), asyncMiddleware(adminController.AddServices))
//Edit Service
router.patch('/editServices/:serviceId', uploadServiceImage.single('serviceImg'), asyncMiddleware(adminController.editServices))
//Delete Service
router.delete('/deleteServices/:serviceId', asyncMiddleware(adminController.deleteServices))
//create categories 
router.post('/addCategory', uploadcategoryImage.single('CategoryImg'), asyncMiddleware(adminController.AddCategories))
//create SubCategories
router.post('/addSubCategories', asyncMiddleware(adminController.addSubCategories))
//get categories
router.get('/getcategories', asyncMiddleware(adminController.getCategories))
//Delete Categories
router.delete('/deleteCategories/:categoryId', asyncMiddleware(adminController.deleteCategories))
//Edit Categories
router.patch('/editCategories/:categoryId', uploadcategoryImage.single('CategoryImg'), asyncMiddleware(adminController.editCategories))
//get Services
router.get('/getServices', asyncMiddleware(adminController.getAllServices))
//Update Services Sort Order
router.patch('/updateServicesSortOrder', asyncMiddleware(adminController.updateServicesSortOrder))
//get SubCategories
router.get('/getSubcategories', asyncMiddleware(adminController.getSubcategories))
//Edit SubCategories
router.patch('/editSubCategories/:subCategoryId', asyncMiddleware(adminController.editSubCategories))
//Assign Service to Categories
router.post('/serviceCategoriesAssign', asyncMiddleware(adminController.serviceCategoriesAssign))
//Unassign Service From Categories
router.delete('/unassignServiceFromCategories/:serviceId', asyncMiddleware(adminController.unassignServiceFromCategories))
//Delete SubCategories
router.delete('/deleteSubCategories/:subCategoryId', asyncMiddleware(adminController.deleteSubCategories))

//!---------------------------------------Admin Dashboard-----------------------------------------//
router.get('/adminDashboard', asyncMiddleware(adminController.adminDashboard))

//!-------------------------Machinery-----------------------------------------------------------------------------//
router.post('/addMachines', asyncMiddleware(adminController.addMachines))

//!-------------------------Reason Management------------------------------------------------------------------//
//Create Reason
router.post('/createReason', asyncMiddleware(adminController.createReason))
//Get Reason By ID
router.get('/getReasonById/:reasonId', asyncMiddleware(adminController.getReasonById))
//Update Reason
router.patch('/updateReason/:reasonId', asyncMiddleware(adminController.updateReason))
//Delete Reason
router.delete('/deleteReason/:reasonId', asyncMiddleware(adminController.deleteReason))

//!-------------------------Account Deletion Reasons--------------------------------------------------------//
router.get('/getAccountDeletionReasons', asyncMiddleware(adminController.getAccountDeletionReasons))
router.post('/createAccountDeletionReason', asyncMiddleware(adminController.createAccountDeletionReason))
router.patch('/updateAccountDeletionReason/:id', asyncMiddleware(adminController.updateAccountDeletionReason))
router.delete('/deleteAccountDeletionReason/:id', asyncMiddleware(adminController.deleteAccountDeletionReason))

//!-------------------------Add-On Categories------------------------------------------------------------------//
router.post('/createAddOnCategory', asyncMiddleware(adminController.createAddOnCategory))
router.get('/getAllAddOnCategories', asyncMiddleware(adminController.getAllAddOnCategories))
router.get('/getAddOnCategoryById/:addOnCategoryId', asyncMiddleware(adminController.getAddOnCategoryById))
router.patch('/updateAddOnCategory/:addOnCategoryId', asyncMiddleware(adminController.updateAddOnCategory))
router.delete('/deleteAddOnCategory/:addOnCategoryId', asyncMiddleware(adminController.deleteAddOnCategory))

//!-------------------------Add-On Services------------------------------------------------------------------//
router.post('/createAddOnService', asyncMiddleware(adminController.createAddOnService))
router.get('/getAllAddOnServices', asyncMiddleware(adminController.getAllAddOnServices))
router.get('/getAddOnServiceById/:addOnServiceId', asyncMiddleware(adminController.getAddOnServiceById))
router.patch('/updateAddOnService/:addOnServiceId', asyncMiddleware(adminController.updateAddOnService))
router.delete('/deleteAddOnService/:addOnServiceId', asyncMiddleware(adminController.deleteAddOnService))

//!-------------------------Account Preferences------------------------------------------------------------------//
//Add Preference Types
router.post('/createPreferenceType', asyncMiddleware(adminController.createPreferenceType))
//Get Preference Types
router.get('/getPreferenceTypes', asyncMiddleware(adminController.getPreferenceTypes))
//Edit Preference Type
router.patch('/editPreferenceType/:preferenceTypeId', asyncMiddleware(adminController.editPreferenceType))
//Delete Preference Type
router.delete('/deletePreferenceType/:preferenceTypeId', asyncMiddleware(adminController.deletePreferenceTypeController))
//Add Preference Values
router.post('/addPreferenceValues', asyncMiddleware(adminController.addPreferenceValues))
//Edit Preference Values
router.patch('/editPreferenceValues/:preferenceValueId', asyncMiddleware(adminController.editPreferenceValuesController))
//Delete Preference Values
router.delete('/deletePreferenceValues/:preferenceValueId', asyncMiddleware(adminController.deletePreferenceValuesController))
//Add Service With Preferences
router.post('/addServiceWithPreferences', asyncMiddleware(adminController.addServiceWithPreferences))
//Get Preferences && Services Data 
router.get("/servicesAndPreferencesData/:serviceId", asyncMiddleware(adminController.servicesAndPreferencesData))
//unAttach Service From Preferences
router.delete('/unAssignServiceFromPreferences/:serviceId', asyncMiddleware(adminController.unAssignServiceFromPreferences))
//!----------------------------On Hold Options------------------------------------------------------------------//
//On Hold Options Add
router.post('/onHoldOptions', asyncMiddleware(adminController.onHoldOptions))
//On Hold Customer Option
router.post('/customerOnHoldOptions', asyncMiddleware(adminController.customerOnHoldOptions))
//Get Customer On Hold Options
router.get('/getOnHoldCustomerOptions', asyncMiddleware(adminController.getOnHoldCustomerOptions))
//Get on  Hold Options
router.get('/getOnHoldOptions', asyncMiddleware(adminController.getOnHoldOptions))
//Get All On Hold Bookings
router.get('/getOnHoldBookings', asyncMiddleware(adminController.getOnHoldBookings))
//!-------------------------------Customer Management---------------------------------//
//Get All Customers
router.get('/getAllCustomers', asyncMiddleware(adminController.getAllCustomers))
//Get Customers Count
router.get('/customerCount', asyncMiddleware(adminController.customerCount))
//Get Sepecific customer Details 
router.get('/specificCustomerDetails/:customerId', asyncMiddleware(adminController.specificCustomerDetails))
//Update Customer
router.patch('/updateCustomer/:customerId', asyncMiddleware(adminController.updateCustomer))
//Delete Customer
router.delete('/deleteCustomer/:customerId', asyncMiddleware(adminController.deleteCustomer))
//!-----------------------------Driver Management------------------------------//
//Drivers Count Api
router.get('/countTotalDrivers', asyncMiddleware(adminController.countTotalDrivers))
//All Driver Detail api
router.get('/allDriverMiniDetails', asyncMiddleware(adminController.allDriverMiniDetails))
//Driver Status Change
router.patch('/driverStatusChange/:driverId', asyncMiddleware(adminController.driverStatusChange))
//Specific Drive Details
router.get('/specificdriverDetail/:driverId', asyncMiddleware(adminController.specificdriverDetail))
//Update Driver
router.patch('/updateDriver/:driverId', uploadDriverProfile.single('profileImg'), asyncMiddleware(adminController.updateDriver))
//Delete Driver
router.delete('/deleteDriver/:driverId', asyncMiddleware(adminController.deleteDriver))
//Add Driver by Laundry Shop ID
router.post('/addDriverByLaundryShop', uploadDriverProfile.single('profileImg'), asyncMiddleware(adminController.addDriverByLaundryShop))

//!-----------------------------Order Management------------------------------//
//Get Order Count
router.get('/ordersCount', asyncMiddleware(adminController.ordersCount))
//Get All Order Details
router.get('/allOrderDetails', asyncMiddleware(adminController.allOrderDetails))
//Get All Pending Orders
router.get('/pendingOrders', asyncMiddleware(adminController.pendingOrders))
//Get All Cancel Orders
router.get('/allCancelOrders', asyncMiddleware(adminController.allCancelOrders))
//Get All Completed Orders
router.get('/completeOrders', asyncMiddleware(adminController.completeOrders))
//Get Single Order for Editing
router.get('/getOrderForEdit/:orderId', asyncMiddleware(adminController.getOrderForEdit))
//Invoice creation detail (reuse agent logic) for admin panel
router.get('/invoiceCreation/:bookingId', asyncMiddleware(agentController.invoiceCreation))
//Get service details with selected booking services
router.get('/serviceDetailWithBookingSelection/:bookingId', asyncMiddleware(adminController.getServiceDetailWithBookingSelection))
//Edit Order
router.patch('/editOrder/:orderId', asyncMiddleware(adminController.editOrder))
//Delete Order (Soft Delete)
router.delete('/deleteOrder/:orderId', asyncMiddleware(adminController.deleteOrder))
//Admin update invoice services for an order
router.post('/updateInvoice', asyncMiddleware(adminController.updateInvoice))
//For Order Items Sheet
router.get(
    "/orderItemsSheet", asyncMiddleware(agentController.customerServices)
);
//For Print Label Tags Data (order quantity × unitCount per line)
router.get(
    "/printLabelData/:bookingId", asyncMiddleware(agentController.printLabelData)
);

//!-----------------------------Service Management------------------------------//
//Get Services with CategOries && SubCategoriesCounts
router.get('/getAdminServicesWithCategories', asyncMiddleware(adminController.getAdminServicesWithCategories))
//Add Service Types
router.post('/addServiceTypes', uploadcategoryImage.single('CategoryImg'), asyncMiddleware(adminController.addServiceTypes))
//Get SubCategories&&Items
router.get('/getSubCategories/:categoryId', asyncMiddleware(adminController.getSubCategories))
//Add Service Items
router.post('/addServiceItems', asyncMiddleware(adminController.addServiceItems))
//Get Services and Categories for Order Edit
router.get('/getServicesAndCategoriesForOrderEdit', asyncMiddleware(adminController.getServicesAndCategoriesForOrderEdit))

//!--------------------------------------------Agent Add,roles,classifiedAs------------------------------------------//
//Add Roles
router.post('/AddLaundryRoles', asyncMiddleware(adminController.addRole))
//Update Roles
router.put('/updateRoles', asyncMiddleware(adminController.updateRoles))
//Get Roles
router.get('/getAllRoles', asyncMiddleware(adminController.getAllRoles))
//Add ClassifiedAs 
router.post('/addClassifiedAs', asyncMiddleware(adminController.addClassifiedAs))
//Get ClassifiedAs
router.get('/getClassifiedAs', asyncMiddleware(adminController.getClassifiedAs))
//Add Features
router.post('/addfeatures', asyncMiddleware(adminController.addfeatures))
//Get Features
router.get('/getFeatures', asyncMiddleware(adminController.getFeatures))
//Delete Feature
router.delete('/deleteFeature/:featureId', asyncMiddleware(adminController.deleteFeature))



//!-----------------------------Employee Management------------------------------//
//Get All Employess Of Admin
router.get('/getAdminEmployess', asyncMiddleware(adminController.getAdminEmployess))
//Add Employee
router.post('/adinEmployeeAdd', asyncMiddleware(adminController.addEmployee))
//Update Employee
router.patch('/updateEmployee', asyncMiddleware(adminController.updateEmployee))
//update Employee Status
router.patch('/updateEmployeeStatus', asyncMiddleware(adminController.changeEmployeeStatus))
//Get Specific Admin Employee
router.get('/getAdminEmployeeDetail/:employeeId', asyncMiddleware(adminController.getAdminEmployeeDetail))
//Update Admin Employee
router.patch('/updateAdminEmployee', asyncMiddleware(adminController.updateAdminEmployee))
//Delete Admin Employee (Soft Delete)
router.delete('/deleteAdminEmployee/:employeeId', asyncMiddleware(adminController.deleteAdminEmployee))
//Add Agent Employee
router.post('/addAgentEmployee', asyncMiddleware(adminController.addAgentEmployee))
//Update Agent Employee
router.patch('/updateAgentEmployee', asyncMiddleware(adminController.updateAgentEmployee))
//Update Agent Employee Status
router.patch('/updateAgentEmployeeStatus', asyncMiddleware(adminController.changeAgentEmployeeStatus))
//Get All Agent Employees
router.get('/getAllAgentEmployees/:agentId', asyncMiddleware(adminController.getAllAgentEmployees))
//Delete Agent Employee (Soft Delete)
router.delete('/deleteAgentEmployee/:employeeId', asyncMiddleware(adminController.deleteAgentEmployee))

//Agent approval (self-registered agents)
router.get('/pendingAgents', asyncMiddleware(adminController.getPendingAgents))
router.get('/rejectedAgents', asyncMiddleware(adminController.getRejectedAgents))
router.patch('/agents/:agentId/approval', asyncMiddleware(adminController.updateAgentApproval))

//Register Agent (Admin Side)
router.post('/registerAgent', uploadcategoryImage.single('profileImg'), asyncMiddleware(adminController.registerAgent))

//Add Business Information to Agent
router.post('/addAgentBusinessInfo/:userId', asyncMiddleware(adminController.addAgentBusinessInfo))

//Add Services to Agent
router.post('/addAgentServices/:userId', asyncMiddleware(adminController.addAgentServices))

//Update Agent Working Hours
router.patch('/updateAgentWorkingHours/:userId', asyncMiddleware(adminController.updateAgentWorkingHours))

//Get Agent Complete Information
router.get('/getAgentCompleteInfo/:userId', asyncMiddleware(adminController.getAgentCompleteInfo))

//Add Agent Address
router.post('/addAgentAddress/:userId', asyncMiddleware(adminController.addAgentAddress))

//Edit Agent Address
router.patch('/editAgentAddress/:userId', asyncMiddleware(adminController.editAgentAddress))

//Get Agent Address
router.get('/getAgentAddress/:userId', asyncMiddleware(adminController.getAgentAddress))

//Get Shop Address with Business Info
router.get('/getShopAddress/:userId', asyncMiddleware(adminController.getShopAddress))

//!-----------------------------------Agent Settlement------------------------------------//
router.get(
    '/agents/cash-due',
    asyncMiddleware(agentSettlementController.listAgentsWithCashDue)
)
router.get(
    '/agents/remittances/pending',
    asyncMiddleware(agentSettlementController.listPendingRemittances)
)
router.patch(
    '/agents/remittances/:remittanceId/confirm',
    asyncMiddleware(agentSettlementController.confirmCashRemittance)
)
router.patch(
    '/agents/remittances/:remittanceId/reject',
    asyncMiddleware(agentSettlementController.rejectCashRemittance)
)
router.get(
    '/agents/:agentId/settlement',
    asyncMiddleware(agentSettlementController.getAgentSettlement)
)
router.post(
    '/agents/:agentId/cash-settlement',
    asyncMiddleware(agentSettlementController.recordCashSettlement)
)
router.post(
    '/agents/:agentId/settlement-adjustment',
    asyncMiddleware(agentSettlementController.recordSettlementAdjustment)
)
router.post(
    '/agents/:agentId/payout',
    asyncMiddleware(agentSettlementController.recordAgentPayout)
)
router.post(
    '/agents/wallet-sync',
    asyncMiddleware(agentSettlementController.syncAgentWalletsFromBookings)
)

//!-----------------------------------Shop Management------------------------------------>>>>
//Shops Data Counts
router.get('/getShopInformation', asyncMiddleware(adminController.getShopInformation))
//Get Shops Data
router.get('/getShopsData', asyncMiddleware(adminController.shopsData))
//Single Shop Data
router.get('/singleShopData/:Id', asyncMiddleware(adminController.singleShopData))
//Delete Shop (Soft Delete)
router.delete('/deleteShop/:shopId', asyncMiddleware(adminController.deleteShop))
//Get Shop Employees 
router.get('/getShopEmployees/:bussinessId', asyncMiddleware(adminController.getShopEmployees))
//Get All Employees with Shop Information
router.get('/getAllEmployeesWithShopInfo', asyncMiddleware(adminController.getAllEmployeesWithShopInfo))


//!-----------------------------------Cancellation Policy Management------------------------------------>>>>
// Add Cancellation Policy
router.post('/addCancellationPolicy', asyncMiddleware(adminController.createCancellationPolicyController))
// Get Cancellation Policy by ID
router.get('/getCancellationPolicy/:id', asyncMiddleware(adminController.getCancellationPolicyByIdController))
// Update Cancellation Policy
router.put('/updateCancellationPolicy/:id', asyncMiddleware(adminController.updateCancellationPolicyController))
// Delete Cancellation Policy
router.delete('/deleteCancellationPolicy/:id', asyncMiddleware(adminController.deleteCancellationPolicyController))
// Set Default Cancellation Policy
router.patch('/setDefaultCancellationPolicy/:id', asyncMiddleware(adminController.setDefaultCancellationPolicyController))
// Toggle Cancellation Policy Status
router.patch('/toggleCancellationPolicyStatus/:id', asyncMiddleware(adminController.toggleCancellationPolicyStatusController))
// Get Cancellation Policy Statistics
router.get('/getCancellationPolicyStatistics', asyncMiddleware(adminController.getCancellationPolicyStatisticsController))
// Get Active Cancellation Policy
router.get('/getActiveCancellationPolicy', asyncMiddleware(adminController.getActiveCancellationPolicyController))

//!-----------------------------------No-Show Policy Management------------------------------------>>>>
// Add No-Show Policy
router.post('/addNoShowPolicy', asyncMiddleware(adminController.createNoShowPolicyController))
// Get All No-Show Policies
router.get('/getNoShowPolicies', asyncMiddleware(adminController.getAllNoShowPoliciesController))
// Get No-Show Policy by ID
router.get('/getNoShowPolicy/:id', asyncMiddleware(adminController.getNoShowPolicyByIdController))
// Update No-Show Policy
router.put('/updateNoShowPolicy/:id', asyncMiddleware(adminController.updateNoShowPolicyController))
// Delete No-Show Policy
router.delete('/deleteNoShowPolicy/:id', asyncMiddleware(adminController.deleteNoShowPolicyController))
// Set Default No-Show Policy
router.patch('/setDefaultNoShowPolicy/:id', asyncMiddleware(adminController.setDefaultNoShowPolicyController))
// Toggle No-Show Policy Status
router.patch('/toggleNoShowPolicyStatus/:id', asyncMiddleware(adminController.toggleNoShowPolicyStatusController))
// Get Active No-Show Policy
router.get('/getActiveNoShowPolicy', asyncMiddleware(adminController.getActiveNoShowPolicyController))
// Get No-Show Policy Statistics
router.get('/getNoShowPolicyStatistics', asyncMiddleware(adminController.getNoShowPolicyStatisticsController))


//!-----------------------------------Reschedule Policy Management------------------------------------>>>>
// Add Reschedule Policy
router.post('/addReschedulePolicy', asyncMiddleware(adminController.createReschedulePolicyController))
// Get All Reschedule Policies
router.get('/getReschedulePolicies', asyncMiddleware(adminController.getAllReschedulePoliciesController))
// Get Reschedule Policy by ID
router.get('/getReschedulePolicy/:id', asyncMiddleware(adminController.getReschedulePolicyByIdController))
// Update Reschedule Policy
router.put('/updateReschedulePolicy/:id', asyncMiddleware(adminController.updateReschedulePolicyController))
// Delete Reschedule Policy
router.delete('/deleteReschedulePolicy/:id', asyncMiddleware(adminController.deleteReschedulePolicyController))
// Set Default Reschedule Policy
router.patch('/setDefaultReschedulePolicy/:id', asyncMiddleware(adminController.setDefaultReschedulePolicyController))
// Toggle Reschedule Policy Status
router.patch('/toggleReschedulePolicyStatus/:id', asyncMiddleware(adminController.toggleReschedulePolicyStatusController))
// Get Active Reschedule Policy
router.get('/getActiveReschedulePolicy', asyncMiddleware(adminController.getActiveReschedulePolicyController))
// Get Reschedule Policy Statistics
router.get('/getReschedulePolicyStatistics', asyncMiddleware(adminController.getReschedulePolicyStatisticsController))



//!-----------------------------------FAQ Management------------------------------------>>>>
// Create FAQ
router.post('/createFAQ', asyncMiddleware(adminController.createFAQ))

// Get FAQ by ID
router.get('/getFAQ/:faqId', asyncMiddleware(adminController.getFAQById))
// Update FAQ
router.put('/updateFAQ/:faqId', asyncMiddleware(adminController.updateFAQ))
// Delete FAQ
router.delete('/deleteFAQ/:faqId', asyncMiddleware(adminController.deleteFAQ))
// Toggle FAQ Status
router.patch('/toggleFAQStatus/:faqId', asyncMiddleware(adminController.toggleFAQStatus))


//!-----------------------------------Blog Management------------------------------------>>>>
// Create Blog
router.post('/createBlog', uploadBlogImage.fields([
    { name: 'image', maxCount: 1 },
    { name: 'descriptionImages', maxCount: 10 }
]), asyncMiddleware(adminController.createBlog))


// Update Blog
router.put('/updateBlog/:blogId', uploadBlogImage.fields([
    { name: 'image', maxCount: 1 },
    { name: 'descriptionImages', maxCount: 10 }
]), asyncMiddleware(adminController.updateBlog))
// Delete Blog
router.delete('/deleteBlog/:blogId', asyncMiddleware(adminController.deleteBlog))
// Toggle Blog Status
router.patch('/toggleBlogStatus/:blogId', asyncMiddleware(adminController.toggleBlogStatus))



//!-----------------------------------Order Status------------------------------------>>>>
// Get All Order Statuses
router.get('/allOrderStatuses', asyncMiddleware(adminController.getAllOrderStatuses))


//!-----------------------------------Reports------------------------------------>>>>
// 1. Top Services Report
router.get('/reports/top-services', asyncMiddleware(reportsController.getTopServicesReport))
// 2. Hourly Report
router.get('/reports/hourly', asyncMiddleware(reportsController.getHourlyReport))
// 3. On Hold Report
router.get('/reports/on-hold', asyncMiddleware(reportsController.getOnHoldReport))
// 4. Service Demand Report
router.get('/reports/service-demand', asyncMiddleware(reportsController.getServiceDemandReport))
// 5. Top Performing Shops
router.get('/reports/top-shops', asyncMiddleware(reportsController.getTopShopsReport))
// 6. Daily Earning Report
router.get('/reports/daily-earnings', asyncMiddleware(reportsController.getDailyEarningReport))
// 7. Daily Earning Report by Zone
router.get('/reports/daily-earnings/zone', asyncMiddleware(reportsController.getDailyEarningByZoneReport))
// 8. Daily Earning Report by Shop
router.get('/reports/daily-earnings/shop', asyncMiddleware(reportsController.getDailyEarningByShopReport))

//!-----------------------------------Notify / Call Logs (Twilio + push)------------------------------------>>>>
router.get('/notify-logs', asyncMiddleware(notifyLogsController.getNotifyLogs))


//!-----------------------------------Coupon Management------------------------------------>>>>
// Create a coupon
router.post('/addCoupon', validateAccessToken, asyncMiddleware(couponController.createCoupon));
// List all coupons (with optional ?isActive=true&page=1&limit=20)
router.get('/getAllCoupons', validateAccessToken, asyncMiddleware(couponController.getAllCoupons));
// Coupon usage/discount report (must be before /:id to avoid route conflict)
router.get('/getCouponReport', validateAccessToken, asyncMiddleware(couponController.getCouponReport));
// Get single coupon with redemption history
router.get('/getCouponById/:id', validateAccessToken, asyncMiddleware(couponController.getCouponById));
// Update a coupon
router.put('/updateCoupon/:id', validateAccessToken, asyncMiddleware(couponController.updateCoupon));
// Deactivate (soft-delete) a coupon
router.delete('/deleteCoupon/:id', validateAccessToken, asyncMiddleware(couponController.deactivateCoupon));

//!-----------------------------------Banner & Offers------------------------------------>>>>
// Create banner with image + payload in one request (multipart/form-data)
router.post(
    '/createBanner',
    uploadBannerImage.single('image'),
    asyncMiddleware(bannerController.createBanner)
);
// List / manage banners (JSON body or query only)
router.get('/getAllBanners', asyncMiddleware(bannerController.getAllBanners));
router.patch('/updateBanner/:id', asyncMiddleware(bannerController.updateBanner));
router.delete('/deleteBanner/:id', asyncMiddleware(bannerController.deleteBanner));

module.exports = router
const express = require('express')
const router = express()
const asyncMiddleware = require('../middlewares/asyncHandler')
const adminController = require('../controllers/Admin/admin')
const adminAuth = require('../controllers/Admin/adminAuth')
const multer = require('multer')
const path = require('path')
const validateAccessToken = require('../middlewares/adminValidateToken')
const { createDestinationDirectory } = require('../utils/destination')
const agentController = require("../controllers/Agent/agents");


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





//!----------------------------------------Auth Api's----------------------------------------------//

//Admin SignIn
router.post('/adminSignIn', asyncMiddleware(adminAuth.signIn))

//Add vehicle
router.post('/addvehicle', uploadVehicleTypeImage.single('image'), asyncMiddleware(adminController.addVehicle))

//Add Countries
router.post('/addCountries', validateAccessToken, uploadFlagImg.single('flagImg'), asyncMiddleware(adminController.addCountries))
//Get Countries
router.get('/getCountries', validateAccessToken, asyncMiddleware(adminController.getCountries))
//Update Country
router.put('/updateCountry/:countryId', validateAccessToken, uploadFlagImg.single('flagImg'), asyncMiddleware(adminController.updateCountry))
//Delete Country (Soft Delete)
router.delete('/deleteCountry/:countryId', validateAccessToken, asyncMiddleware(adminController.deleteCountry))
//Add Cities
router.post('/addCities', validateAccessToken, asyncMiddleware(adminController.addCities))
//Get Cities
router.get('/getCities', validateAccessToken, asyncMiddleware(adminController.getCities))
//Get Cities by Country Id
router.get('/getCitiesByCountryId/:countryId', validateAccessToken, asyncMiddleware(adminController.getCitiesByCountryId))
//Update City
router.put('/updateCity/:cityId', validateAccessToken, asyncMiddleware(adminController.updateCity))
//Delete City (Soft Delete)
router.delete('/deleteCity/:cityId', validateAccessToken, asyncMiddleware(adminController.deleteCity))
//!---------------------------------------Zones-----------------------------------------//
//Add Zones
router.post('/addZone', validateAccessToken, asyncMiddleware(adminController.addZones))
//Add Zones by Postcodes
router.post('/addZoneByPostcodes', validateAccessToken, asyncMiddleware(adminController.addZonesByPostcodes))
// Get Zones
router.get('/getZones', validateAccessToken, asyncMiddleware(adminController.getZones))
//Delete Zone
router.delete('/delete-zone', validateAccessToken, asyncMiddleware(adminController.deleteZone))
//Update Zone
router.patch('/updateZone/:zoneId', validateAccessToken, asyncMiddleware(adminController.updateZone))
//!---------------------------------------Units-----------------------------------------//
//Get Units
router.get('/getUnitsDistanceAndCurrency', validateAccessToken, asyncMiddleware(adminController.getUnitsDistanceAndCurrency))
//Get All Units
router.get('/getAllUnits', validateAccessToken, asyncMiddleware(adminController.getAllUnits))
//!---------------------------------------Services,Categories,SubCategories-----------------------------------------//
//Create Service 
router.post("/AddServices", validateAccessToken, uploadServiceImage.single('serviceImg'), asyncMiddleware(adminController.AddServices))
//Edit Service
router.patch('/editServices/:serviceId', validateAccessToken,uploadServiceImage.single('serviceImg'), asyncMiddleware(adminController.editServices))
//Delete Service
router.delete('/deleteServices/:serviceId', validateAccessToken, asyncMiddleware(adminController.deleteServices))
//create categories 
router.post('/addCategory', validateAccessToken, uploadcategoryImage.single('CategoryImg'), asyncMiddleware(adminController.AddCategories))
//create SubCategories
router.post('/addSubCategories', validateAccessToken, asyncMiddleware(adminController.addSubCategories))
//get categories
router.get('/getcategories', validateAccessToken, asyncMiddleware(adminController.getCategories))
//Delete Categories
router.delete('/deleteCategories/:categoryId', validateAccessToken, asyncMiddleware(adminController.deleteCategories))
//Edit Categories
router.patch('/editCategories/:categoryId', validateAccessToken, asyncMiddleware(adminController.editCategories))
//get Services
router.get('/getServices', validateAccessToken, asyncMiddleware(adminController.getAllServices))
//get SubCategories
router.get('/getSubcategories', validateAccessToken, asyncMiddleware(adminController.getSubcategories))
//Edit SubCategories
router.patch('/editSubCategories/:subCategoryId', validateAccessToken, asyncMiddleware(adminController.editSubCategories))
//Assign Service to Categories
router.post('/serviceCategoriesAssign', validateAccessToken, asyncMiddleware(adminController.serviceCategoriesAssign))
//Unassign Service From Categories
router.delete('/unassignServiceFromCategories/:serviceId', validateAccessToken, asyncMiddleware(adminController.unassignServiceFromCategories))
//Delete SubCategories
router.delete('/deleteSubCategories/:subCategoryId', validateAccessToken, asyncMiddleware(adminController.deleteSubCategories))

//!---------------------------------------Admin Dashboard-----------------------------------------//
router.get('/adminDashboard', validateAccessToken, asyncMiddleware(adminController.adminDashboard))

//!-------------------------Machinery-----------------------------------------------------------------------------//
router.post('/addMachines', validateAccessToken, asyncMiddleware(adminController.addMachines))

//!-------------------------Reason Management------------------------------------------------------------------//
//Create Reason
router.post('/createReason', validateAccessToken, asyncMiddleware(adminController.createReason))
//Get All Reasons
router.get('/getAllReasons', validateAccessToken, asyncMiddleware(adminController.getAllReasons))
//Get Reason By ID
router.get('/getReasonById/:reasonId', validateAccessToken, asyncMiddleware(adminController.getReasonById))
//Update Reason
router.patch('/updateReason/:reasonId', validateAccessToken, asyncMiddleware(adminController.updateReason))
//Delete Reason
router.delete('/deleteReason/:reasonId', validateAccessToken, asyncMiddleware(adminController.deleteReason))

//!-------------------------Account Preferences------------------------------------------------------------------//
//Add Preference Types
router.post('/createPreferenceType', validateAccessToken, asyncMiddleware(adminController.createPreferenceType))
//Get Preference Types
router.get('/getPreferenceTypes', validateAccessToken, asyncMiddleware(adminController.getPreferenceTypes))
//Edit Preference Type
router.patch('/editPreferenceType/:preferenceTypeId', validateAccessToken, asyncMiddleware(adminController.editPreferenceType))
//Delete Preference Type
router.delete('/deletePreferenceType/:preferenceTypeId', validateAccessToken, asyncMiddleware(adminController.deletePreferenceTypeController))
//Add Preference Values
router.post('/addPreferenceValues', validateAccessToken, asyncMiddleware(adminController.addPreferenceValues))
//Edit Preference Values
router.patch('/editPreferenceValues/:preferenceValueId', validateAccessToken, asyncMiddleware(adminController.editPreferenceValuesController))
//Delete Preference Values
router.delete('/deletePreferenceValues/:preferenceValueId', validateAccessToken, asyncMiddleware(adminController.deletePreferenceValuesController))
//Add Service With Preferences
router.post('/addServiceWithPreferences', validateAccessToken, asyncMiddleware(adminController.addServiceWithPreferences))
//Get Preferences && Services Data 
router.get("/servicesAndPreferencesData/:serviceId",validateAccessToken,asyncMiddleware(adminController.servicesAndPreferencesData))
//unAttach Service From Preferences
router.delete('/unAssignServiceFromPreferences/:serviceId', validateAccessToken, asyncMiddleware(adminController.unAssignServiceFromPreferences))
//!----------------------------On Hold Options------------------------------------------------------------------//
//On Hold Options Add
router.post('/onHoldOptions', validateAccessToken, asyncMiddleware(adminController.onHoldOptions))
//On Hold Customer Option
router.post('/customerOnHoldOptions', validateAccessToken, asyncMiddleware(adminController.customerOnHoldOptions))
//Get Customer On Hold Options
router.get('/getOnHoldCustomerOptions', validateAccessToken, asyncMiddleware(adminController.getOnHoldCustomerOptions))
//Get on  Hold Options
router.get('/getOnHoldOptions', validateAccessToken, asyncMiddleware(adminController.getOnHoldOptions))
//Get All On Hold Bookings
router.get('/getOnHoldBookings', validateAccessToken, asyncMiddleware(adminController.getOnHoldBookings))
//!-------------------------------Customer Management---------------------------------//
//Get All Customers
router.get('/getAllCustomers', validateAccessToken, asyncMiddleware(adminController.getAllCustomers))
//Get Customers Count
router.get('/customerCount', validateAccessToken, asyncMiddleware(adminController.customerCount))
//Get Sepecific customer Details 
router.get('/specificCustomerDetails/:customerId', validateAccessToken, asyncMiddleware(adminController.specificCustomerDetails))
//Update Customer
router.patch('/updateCustomer/:customerId', validateAccessToken, asyncMiddleware(adminController.updateCustomer))
//Delete Customer
router.delete('/deleteCustomer/:customerId', validateAccessToken, asyncMiddleware(adminController.deleteCustomer))
//!-----------------------------Driver Management------------------------------//
//Drivers Count Api
router.get('/countTotalDrivers', validateAccessToken, asyncMiddleware(adminController.countTotalDrivers))
//All Driver Detail api
router.get('/allDriverMiniDetails', validateAccessToken, asyncMiddleware(adminController.allDriverMiniDetails))
//Driver Status Change
router.patch('/driverStatusChange/:driverId', validateAccessToken, asyncMiddleware(adminController.driverStatusChange))
//Specific Drive Details
router.get('/specificdriverDetail/:driverId', validateAccessToken, asyncMiddleware(adminController.specificdriverDetail))
//Update Driver
router.patch('/updateDriver/:driverId', validateAccessToken, uploadDriverProfile.single('profileImg'), asyncMiddleware(adminController.updateDriver))
//Delete Driver
router.delete('/deleteDriver/:driverId', validateAccessToken, asyncMiddleware(adminController.deleteDriver))
//Add Driver by Laundry Shop ID
router.post('/addDriverByLaundryShop', validateAccessToken, uploadDriverProfile.single('profileImg'), asyncMiddleware(adminController.addDriverByLaundryShop))

//!-----------------------------Order Management------------------------------//
//Get Order Count
router.get('/ordersCount', validateAccessToken, asyncMiddleware(adminController.ordersCount))
//Get All Order Details
router.get('/allOrderDetails', validateAccessToken, asyncMiddleware(adminController.allOrderDetails))
//Get All Pending Orders
router.get('/pendingOrders', validateAccessToken, asyncMiddleware(adminController.pendingOrders))
//Get All Cancel Orders
router.get('/allCancelOrders', validateAccessToken, asyncMiddleware(adminController.allCancelOrders))
//Get All Completed Orders
router.get('/completeOrders', validateAccessToken, asyncMiddleware(adminController.completeOrders))
//Get Single Order for Editing
router.get('/getOrderForEdit/:orderId', validateAccessToken, asyncMiddleware(adminController.getOrderForEdit))
//Edit Order
router.patch('/editOrder/:orderId', validateAccessToken, asyncMiddleware(adminController.editOrder))
//Delete Order (Soft Delete)
router.delete('/deleteOrder/:orderId', validateAccessToken, asyncMiddleware(adminController.deleteOrder))
//For Order Items Sheet
router.get(
    "/orderItemsSheet",
    validateAccessToken,
    asyncMiddleware(agentController.customerServices)
);

//!-----------------------------Service Management------------------------------//
//Get Services with CategOries && SubCategoriesCounts
router.get('/getAdminServicesWithCategories', validateAccessToken, asyncMiddleware(adminController.getAdminServicesWithCategories))
//Add Service Types
router.post('/addServiceTypes', validateAccessToken, uploadcategoryImage.single('CategoryImg'), asyncMiddleware(adminController.addServiceTypes))
//Get SubCategories&&Items
router.get('/getSubCategories/:categoryId', validateAccessToken, asyncMiddleware(adminController.getSubCategories))
//Add Service Items
router.post('/addServiceItems', validateAccessToken, asyncMiddleware(adminController.addServiceItems))
//Get Services and Categories for Order Edit
router.get('/getServicesAndCategoriesForOrderEdit', validateAccessToken, asyncMiddleware(adminController.getServicesAndCategoriesForOrderEdit))

//!--------------------------------------------Agent Add,roles,classifiedAs------------------------------------------//
//Add Roles
router.post('/AddLaundryRoles', validateAccessToken, asyncMiddleware(adminController.addRole))
//Update Roles
router.put('/updateRoles', validateAccessToken, asyncMiddleware(adminController.updateRoles))
//Get Roles
router.get('/getAllRoles', validateAccessToken, asyncMiddleware(adminController.getAllRoles))
//Add ClassifiedAs 
router.post('/addClassifiedAs', validateAccessToken, asyncMiddleware(adminController.addClassifiedAs))
//Get ClassifiedAs
router.get('/getClassifiedAs', validateAccessToken, asyncMiddleware(adminController.getClassifiedAs))
//Add Features
router.post('/addfeatures', validateAccessToken, asyncMiddleware(adminController.addfeatures))



//!-----------------------------Employee Management------------------------------//
//Get All Employess Of Admin
router.get('/getAdminEmployess', validateAccessToken, asyncMiddleware(adminController.getAdminEmployess))
//Add Employee
router.post('/adinEmployeeAdd', validateAccessToken, asyncMiddleware(adminController.addEmployee))
//Update Employee
router.patch('/updateEmployee', validateAccessToken, asyncMiddleware(adminController.updateEmployee))
//update Employee Status
router.patch('/updateEmployeeStatus', validateAccessToken, asyncMiddleware(adminController.changeEmployeeStatus))
//Add Agent Employee
router.post('/addAgentEmployee', validateAccessToken, asyncMiddleware(adminController.addAgentEmployee))
//Update Agent Employee
router.patch('/updateAgentEmployee', validateAccessToken, asyncMiddleware(adminController.updateAgentEmployee))
//Update Agent Employee Status
router.patch('/updateAgentEmployeeStatus', validateAccessToken, asyncMiddleware(adminController.changeAgentEmployeeStatus))
//Get All Agent Employees
router.get('/getAllAgentEmployees/:agentId', validateAccessToken, asyncMiddleware(adminController.getAllAgentEmployees))

//Register Agent (Admin Side)
router.post('/registerAgent', validateAccessToken, uploadcategoryImage.single('profileImg'), asyncMiddleware(adminController.registerAgent))

//Add Business Information to Agent
router.post('/addAgentBusinessInfo/:userId', validateAccessToken, asyncMiddleware(adminController.addAgentBusinessInfo))

//Add Services to Agent
router.post('/addAgentServices/:userId', validateAccessToken, asyncMiddleware(adminController.addAgentServices))

//Update Agent Working Hours
router.patch('/updateAgentWorkingHours/:userId', validateAccessToken, asyncMiddleware(adminController.updateAgentWorkingHours))

//Get Agent Complete Information
router.get('/getAgentCompleteInfo/:userId', validateAccessToken, asyncMiddleware(adminController.getAgentCompleteInfo))


//!-----------------------------------Shop Management------------------------------------>>>>
//Shops Data Counts
router.get('/getShopInformation', validateAccessToken, asyncMiddleware(adminController.getShopInformation))
//Get Shops Data
router.get('/getShopsData', validateAccessToken, asyncMiddleware(adminController.shopsData))
//Single Shop Data
router.get('/singleShopData/:Id', validateAccessToken, asyncMiddleware(adminController.singleShopData))
//Delete Shop (Soft Delete)
router.delete('/deleteShop/:shopId', validateAccessToken, asyncMiddleware(adminController.deleteShop))
//Get Shop Employees 
router.get('/getShopEmployees/:bussinessId', validateAccessToken, asyncMiddleware(adminController.getShopEmployees))
//Get All Employees with Shop Information
router.get('/getAllEmployeesWithShopInfo', validateAccessToken, asyncMiddleware(adminController.getAllEmployeesWithShopInfo))


//!-----------------------------------Cancellation Policy Management------------------------------------>>>>
// Add Cancellation Policy
router.post('/addCancellationPolicy', validateAccessToken, asyncMiddleware(adminController.createCancellationPolicyController))
// Get All Cancellation Policies
router.get('/getCancellationPolicies', validateAccessToken, asyncMiddleware(adminController.getAllCancellationPoliciesController))
// Get Cancellation Policy by ID
router.get('/getCancellationPolicy/:id', validateAccessToken, asyncMiddleware(adminController.getCancellationPolicyByIdController))
// Update Cancellation Policy
router.put('/updateCancellationPolicy/:id', validateAccessToken, asyncMiddleware(adminController.updateCancellationPolicyController))
// Delete Cancellation Policy
router.delete('/deleteCancellationPolicy/:id', validateAccessToken, asyncMiddleware(adminController.deleteCancellationPolicyController))
// Set Default Cancellation Policy
router.patch('/setDefaultCancellationPolicy/:id', validateAccessToken, asyncMiddleware(adminController.setDefaultCancellationPolicyController))
// Toggle Cancellation Policy Status
router.patch('/toggleCancellationPolicyStatus/:id', validateAccessToken, asyncMiddleware(adminController.toggleCancellationPolicyStatusController))
// Get Active Cancellation Policy
router.get('/getActiveCancellationPolicy', validateAccessToken, asyncMiddleware(adminController.getActiveCancellationPolicyController))
// Get Cancellation Policy Statistics
router.get('/getCancellationPolicyStatistics', validateAccessToken, asyncMiddleware(adminController.getCancellationPolicyStatisticsController))


//!-----------------------------------No-Show Policy Management------------------------------------>>>>
// Add No-Show Policy
router.post('/addNoShowPolicy', validateAccessToken, asyncMiddleware(adminController.createNoShowPolicyController))
// Get All No-Show Policies
router.get('/getNoShowPolicies', validateAccessToken, asyncMiddleware(adminController.getAllNoShowPoliciesController))
// Get No-Show Policy by ID
router.get('/getNoShowPolicy/:id', validateAccessToken, asyncMiddleware(adminController.getNoShowPolicyByIdController))
// Update No-Show Policy
router.put('/updateNoShowPolicy/:id', validateAccessToken, asyncMiddleware(adminController.updateNoShowPolicyController))
// Delete No-Show Policy
router.delete('/deleteNoShowPolicy/:id', validateAccessToken, asyncMiddleware(adminController.deleteNoShowPolicyController))
// Set Default No-Show Policy
router.patch('/setDefaultNoShowPolicy/:id', validateAccessToken, asyncMiddleware(adminController.setDefaultNoShowPolicyController))
// Toggle No-Show Policy Status
router.patch('/toggleNoShowPolicyStatus/:id', validateAccessToken, asyncMiddleware(adminController.toggleNoShowPolicyStatusController))
// Get Active No-Show Policy
router.get('/getActiveNoShowPolicy', validateAccessToken, asyncMiddleware(adminController.getActiveNoShowPolicyController))
// Get No-Show Policy Statistics
router.get('/getNoShowPolicyStatistics', validateAccessToken, asyncMiddleware(adminController.getNoShowPolicyStatisticsController))


//!-----------------------------------FAQ Management------------------------------------>>>>
// Create FAQ
router.post('/createFAQ', validateAccessToken, asyncMiddleware(adminController.createFAQ))
// Get All FAQs
router.get('/getAllFAQs', asyncMiddleware(adminController.getAllFAQs))
// Get FAQ by ID
router.get('/getFAQ/:faqId', validateAccessToken, asyncMiddleware(adminController.getFAQById))
// Update FAQ
router.put('/updateFAQ/:faqId', validateAccessToken, asyncMiddleware(adminController.updateFAQ))
// Delete FAQ
router.delete('/deleteFAQ/:faqId', validateAccessToken, asyncMiddleware(adminController.deleteFAQ))
// Toggle FAQ Status
router.patch('/toggleFAQStatus/:faqId', validateAccessToken, asyncMiddleware(adminController.toggleFAQStatus))


//!-----------------------------------Blog Management------------------------------------>>>>
// Create Blog
router.post('/createBlog', validateAccessToken, uploadBlogImage.fields([
    { name: 'image', maxCount: 1 },
    { name: 'descriptionImages', maxCount: 10 }
]), asyncMiddleware(adminController.createBlog))
// Get All Blogs
router.get('/getAllBlogs', validateAccessToken, asyncMiddleware(adminController.getAllBlogs))
// Get Blog by ID
router.get('/getBlog/:blogId', validateAccessToken, asyncMiddleware(adminController.getBlogById))
// Update Blog
router.put('/updateBlog/:blogId', validateAccessToken, uploadBlogImage.fields([
    { name: 'image', maxCount: 1 },
    { name: 'descriptionImages', maxCount: 10 }
]), asyncMiddleware(adminController.updateBlog))
// Delete Blog
router.delete('/deleteBlog/:blogId', validateAccessToken, asyncMiddleware(adminController.deleteBlog))
// Toggle Blog Status
router.patch('/toggleBlogStatus/:blogId', validateAccessToken, asyncMiddleware(adminController.toggleBlogStatus))


module.exports = router
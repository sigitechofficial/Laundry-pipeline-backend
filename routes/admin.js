const express = require('express')
const router = express()
const asyncMiddleware = require('../middlewares/asyncHandler')
const adminController = require('../controllers/Admin/admin')
const adminAuth = require('../controllers/Admin/adminAuth')
const multer = require('multer')
const path = require('path')
const validateAccessToken = require('../middlewares/adminValidateToken')
const { createDestinationDirectory } = require('../utils/destination')


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





//!----------------------------------------Auth Api's----------------------------------------------//

//Admin SignIn
router.post('/adminSignIn', asyncMiddleware(adminAuth.signIn))

//Add vehicle
router.post('/addvehicle', uploadVehicleTypeImage.single('image'), asyncMiddleware(adminController.addVehicle))

//Add Countries
router.post('/addCountries', validateAccessToken, uploadFlagImg.single('flagImg'), asyncMiddleware(adminController.addCountries))
//Get Countries
router.get('/getCountries', validateAccessToken, asyncMiddleware(adminController.getCountries))
//Add Cities
router.post('/addCities', validateAccessToken, asyncMiddleware(adminController.addCities))
//Get Cities
router.get('/getCities', validateAccessToken, asyncMiddleware(adminController.getCities))
//!---------------------------------------Zones-----------------------------------------//
//Add Zones
router.post('/addZone', validateAccessToken, asyncMiddleware(adminController.addZones))
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
//Delete SubCategories
router.delete('/deleteSubCategories/:subCategoryId', validateAccessToken, asyncMiddleware(adminController.deleteSubCategories))

//!---------------------------------------Admin Dashboard-----------------------------------------//
router.get('/adminDashboard', validateAccessToken, asyncMiddleware(adminController.adminDashboard))


//!---------------------------------------Cancel Api---------------------------------------------------------------//
//Create cancel booking reasons
router.post('/cancelBooking', validateAccessToken, asyncMiddleware(adminController.cancelBooking))
//Get All Cancel Booking Reasons
router.get('/getCancelReasons', validateAccessToken, asyncMiddleware(adminController.getCancelBookingReasons))
//!-------------------------Machinery-----------------------------------------------------------------------------//
router.post('/addMachines', validateAccessToken, asyncMiddleware(adminController.addMachines))
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
router.patch('/updateDriver/:driverId', validateAccessToken, asyncMiddleware(adminController.updateDriver))

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
router.get('/getAllAgentEmployees', validateAccessToken, asyncMiddleware(adminController.getAllAgentEmployees))


//!-----------------------------------Shop Management------------------------------------>>>>
//Shops Data Counts
router.get('/getShopInformation', validateAccessToken, asyncMiddleware(adminController.getShopInformation))
//Get Shops Data
router.get('/getShopsData', validateAccessToken, asyncMiddleware(adminController.shopsData))
//Single Shop Data
router.get('/singleShopData/:Id', validateAccessToken, asyncMiddleware(adminController.singleShopData))
//Get Shop Employees 
router.get('/getShopEmployees/:bussinessId', validateAccessToken, asyncMiddleware(adminController.getShopEmployees))











module.exports = router
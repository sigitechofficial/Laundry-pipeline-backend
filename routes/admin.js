const express=require('express')
const router=express()
const asyncMiddleware=require('../middlewares/asyncHandler')
const adminController=require('../controllers/Admin/admin')
const adminAuth=require('../controllers/Admin/adminAuth')
const multer=require('multer')
const path=require('path')
const validateAccessToken=require('../middlewares/adminValidateToken')
const {createDestinationDirectory}=require('../utils/destination')


//!-------------------------------------Multer Middlewares---------------------//
//upload Vehicle Type Image
const uploadVehicleType = multer.diskStorage({
    destination: (req, file, cb) => {
      const destinationPath=`./Public/Images/VehicleTypes`;

      createDestinationDirectory(destinationPath,cb)
    },
    filename: (req, file, cb) => {
        cb(null, 'vehicleImage-' + req.body.title + '-'+ Date.now() +  path.extname(file.originalname))
    }
})
const uploadVehicleTypeImage = multer({
    storage: uploadVehicleType,
});


//Upload Country Images
const uploadCountryflagImg=multer.diskStorage({
    destination:(req,file,cb)=>{
        const destinationPath=`./Public/Images/CountryFlags`;
        createDestinationDirectory(destinationPath,cb)
    },
    filename:(req,file,cb)=>{
        cb(null,'flagImg-'+req.body.shortName+'-'+ Date.now()+ path.extname(file.originalname))
    }
})

const uploadFlagImg=multer({
    storage:uploadCountryflagImg,
})

 
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
  
const uploadcategoryImage=multer({
    storage:uploadCategoryPic
})

//!----------------------------------------Auth Api's----------------------------------------------//

//Admin SignIn
router.post('/adminSignIn',asyncMiddleware(adminAuth.signIn))

//Add vehicle
router.post('/addvehicle',uploadVehicleTypeImage.single('image'), asyncMiddleware(adminController.addVehicle))

//Add Countries
router.post('/addCountries',validateAccessToken,uploadFlagImg.single('flagImg'),asyncMiddleware(adminController.addCountries))
//Get Countries
router.get('/getCountries',validateAccessToken,asyncMiddleware(adminController.getCountries))
//Add Cities
router.post('/addCities',validateAccessToken,asyncMiddleware(adminController.addCities))
//Get Cities
router.get('/getCities',validateAccessToken,asyncMiddleware(adminController.getCities))
//Add Zones
router.post('/addZone',validateAccessToken,asyncMiddleware(adminController.addZones))
// Get Zones
router.get('/getZones',validateAccessToken,asyncMiddleware(adminController.getZones))
//Create Service 
router.post("/AddServices",validateAccessToken,asyncMiddleware(adminController.AddServices))
//create categories 
router.post('/addCategory',validateAccessToken,uploadcategoryImage.single('CategoryImg'),asyncMiddleware(adminController.AddCategories))
//create SubCategories
router.post('/addSubCategories',validateAccessToken,asyncMiddleware(adminController.addSubCategories))
//get categories
router.get('/getcategories',validateAccessToken,asyncMiddleware(adminController.getCategories))
//get Services
router.get('/getServices',validateAccessToken,asyncMiddleware(adminController.getAllServices))
//get SubCategories
router.get('/getSubcategories',validateAccessToken,asyncMiddleware(adminController.getSubcategories))

//!---------------------------------------Cancel Api---------------------------------------------------------------//
//Create cancel booking reasons
router.post('/cancelBooking',validateAccessToken,asyncMiddleware(adminController.cancelBooking))
//Get All Cancel Booking Reasons
router.get('/getCancelReasons',validateAccessToken,asyncMiddleware(adminController.getCancelBookingReasons))
//!-------------------------Machinery-----------------------------------------------------------------------------//
router.post('/addMachines',validateAccessToken,asyncMiddleware(adminController.addMachines))
//!-------------------------Account Preferences------------------------------------------------------------------//
//Add Account Preferences
router.post('/AddServicePreferences',validateAccessToken,asyncMiddleware(adminController.AddServicePreferences))
//Get Account Preferences
router.get('/getAccountPreferences',validateAccessToken,asyncMiddleware(adminController.getAccountPreferences))
//!----------------------------On Hold Options------------------------------------------------------------------//
//On Hold Options Add
router.post('/onHoldOptions',validateAccessToken,asyncMiddleware(adminController.onHoldOptions))
//On Hold Customer Option
router.post('/customerOnHoldOptions',validateAccessToken,asyncMiddleware(adminController.customerOnHoldOptions))
//Get Customer On Hold Options
router.get('/getOnHoldCustomerOptions',validateAccessToken,asyncMiddleware(adminController.getOnHoldCustomerOptions))
//Get on  Hold Options
router.get('/getOnHoldOptions',validateAccessToken,asyncMiddleware(adminController.getOnHoldOptions))
//!-------------------------------Customer Management---------------------------------//
//Get All Customers
router.get('/getAllCustomers',validateAccessToken,asyncMiddleware(adminController.getAllCustomers))
//Get Customers Count
router.get('/customerCount',validateAccessToken,asyncMiddleware(adminController.customerCount))
//Get Sepecific customer Details 
router.get('/specificCustomerDetails/:customerId',validateAccessToken,asyncMiddleware(adminController.specificCustomerDetails))
//!-----------------------------Driver Management------------------------------//
//Drivers Count Api
router.get('/countTotalDrivers',validateAccessToken,asyncMiddleware(adminController.countTotalDrivers))
//All Driver Detail api
router.get('/allDriverMiniDetails',validateAccessToken,asyncMiddleware(adminController.allDriverMiniDetails)) 
//Driver Status Change
router.patch('/driverStatusChange/:driverId',validateAccessToken,asyncMiddleware(adminController.driverStatusChange))
//Specific Drive Details
router.get('/specificdriverDetail/:driverId',validateAccessToken,asyncMiddleware(adminController.specificdriverDetail))

//!-----------------------------Order Management------------------------------//
//Get Order Count
router.get('/ordersCount',validateAccessToken,asyncMiddleware(adminController.ordersCount))
//Get All Order Details
router.get('/allOrderDetails',validateAccessToken,asyncMiddleware(adminController.allOrderDetails))
//Get All Pending Orders
router.get('/pendingOrders',validateAccessToken,asyncMiddleware(adminController.pendingOrders))
//Get All Cancel Orders
router.get('/allCancelOrders',validateAccessToken,asyncMiddleware(adminController.allCancelOrders))
//Get All Completed Orders
router.get('/completeOrders',validateAccessToken,asyncMiddleware(adminController.completeOrders))


//!-----------------------------Service Management------------------------------//
//Get Services with CategOries && SubCategoriesCounts
router.get('/getAdminServicesWithCategories',validateAccessToken,asyncMiddleware(adminController.getAdminServicesWithCategories))
//Add Service Types
router.post('/addServiceTypes',validateAccessToken,uploadcategoryImage.single('CategoryImg'),asyncMiddleware(adminController.addServiceTypes))
//Get SubCategories&&Items
router.get('/getSubCategories/:categoryId',validateAccessToken,asyncMiddleware(adminController.getSubCategories))
//Add Service Items
router.post('/addServiceItems',validateAccessToken,asyncMiddleware(adminController.addServiceItems))

//!--------------------------------------------Agent Add,roles,classifiedAs------------------------------------------//
//Add Roles
router.post('/AddLaundryRoles',validateAccessToken,asyncMiddleware(adminController.addRole))
//Update Roles
router.put('/updateRoles',validateAccessToken,asyncMiddleware(adminController.updateRoles)) 
//Get Roles
router.get('/getAllRoles',validateAccessToken,asyncMiddleware(adminController.getAllRoles))
//Add ClassifiedAs 
router.post('/addClassifiedAs',validateAccessToken,asyncMiddleware(adminController.addClassifiedAs))
//Get ClassifiedAs
router.get('/getClassifiedAs',validateAccessToken,asyncMiddleware(adminController.getClassifiedAs))
//Add Features
router.post('/addfeatures',validateAccessToken,asyncMiddleware(adminController.addfeatures))



//!-----------------------------Employee Management------------------------------//
//Get All Employess Of Admin
router.get('/getAdminEmployess',validateAccessToken,asyncMiddleware(adminController.getAdminEmployess))
//Add Employee
router.post('/adinEmployeeAdd',validateAccessToken,asyncMiddleware(adminController.addEmployee))
//Update Employee
router.patch('/updateEmployee',validateAccessToken,asyncMiddleware(adminController.updateEmployee))
//update Employee Status
router.patch('/updateEmployeeStatus',validateAccessToken,asyncMiddleware(adminController.changeEmployeeStatus))
module.exports=router
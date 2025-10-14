require("dotenv").config();
const { users,
    userType,
    booking,
    otpVerification,
    deviceToken,
    vehicleType,
    countries,
    cities,
    roles,
    zone,
    categories,
    service,
    subCategories,
    reason,
    machines,
    classifiedAs,
    servicePreferences,
    preferencesServiceName,
    onHoldOption,
    onHoldCustomerOption,
    addressDb,
    bookingHistory,
    customerSelectedService,
    OnHoldConfirmation,
    bookingStatus,
    driverInZones,
    bussinessInformation,
    proofOfDeliveries,
    bussinessWorkingHours,
    features,
    preferenceTypes,
    preferenceValues,
    agentSelectServices,
    serviceWithPreferences,
    units,
    billingDetails,
    serviceCategories } = require('../../models')
const sequelize = require('sequelize')
const { Op } = require('sequelize')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const redisCli = require('../../redis/redis')
const otpGenerator = require('otp-generator')
// Keep original customError for backward compatibility
const customError = require('../../middlewares/customError');

// Universal error handling
const { 
    ValidationError, 
    NotFoundError, 
    UnauthorizedError, 
    ConflictError 
} = require('../../middlewares/universalErrorHandler');
const ResponseHelper = require('../../utils/responseHelper');
const otpMail = require('../../helper/otpMail')
const error = require('../../middlewares/error')
const { stat } = require('fs')
const stripe = require('../stripe')
const {
    currentAppUnitsId,
    unitsConversion,
    unitsSymbolsAndRates,
    convertToBaseUnits,
} = require('../../utils/unitsManagement');
const { type } = require("os");
const { group } = require("console");
const { literal } = require('sequelize');
const { registerCustomer } = require("../Customer/customerAuth");
const { createCanvas } = require("canvas")
const JsBarcode = require("jsbarcode")
const fs = require("fs")
const path = require("path");
const geolib = require('geolib');

// Import services
const {
    dashboardService,
    customerService,
    driverService,
    orderService,
    serviceManagementService,
    dataService,
    shopManagementService,
    prefrencesServices,
    employeeManagementService,
    zoneManagementService,
    vehicleManagementService,
    roleManagementService,
    featureManagementService,
    locationManagementService
} = require('../../services/Admin');

//!----------------------------------Admin Dashboard-----------------------------------------//
async function adminDashboard(req, res) {
    
        const outObj = await dashboardService.getDashboardData();
        //return res.json(responsefunc("1", "Admin Dashboard Data", outObj, ""));
        return ResponseHelper.success(res, "Admin Dashboard Data", outObj);
}







//!----------------------------------Customer Management-----------------------------------------//

/*
  * Get All Customers
*/
async function getAllCustomers(req, res) {
            const { startPage = 1, endPage = 10, offset = 0 } = req.query;
            // Convert query parameters to numbers
            const startPageNum = parseInt(startPage);
            const endPageNum = parseInt(endPage);
            const offsetNum = parseInt(offset);
            
            const result = await customerService.getAllCustomers(startPageNum, endPageNum, offsetNum);
            return ResponseHelper.success(res, "All Customer Details", result);
}

/*
   * Customers Count
*/
async function customerCount(req, res) {
        const outObj = await customerService.getCustomerCount();
        return ResponseHelper.success(res, "All Customer Count", outObj);
}



/*
  * Specific Customer Details
*/
async function specificCustomerDetails(req, res) {
        const { customerId } = req.params;
        const output = await customerService.getSpecificCustomerDetails(customerId);
        return ResponseHelper.success(res, "Customer Order Details", output);
}


/*
  * Update Customer Details
*/
async function updateCustomer(req, res) {
    const { customerId } = req.params;
    const { firstName, lastName, email, phoneNum, status } = req.body;
    
    const updateData = { firstName, lastName, email, phoneNum, status };
    const result = await customerService.updateCustomer(customerId, updateData);
    return ResponseHelper.success(res, "Customer updated successfully", result);
}


/*
  * Delete Customer
*/
async function deleteCustomer(req, res) {
    const { customerId } = req.params;
    const result = await customerService.deleteCustomer(customerId);
    return ResponseHelper.success(res, "Customer deleted successfully", result);
}


//!----------------------------------------------------Drivers Management--------------------------------------->>
/* 
 *  Drivers Count
*/
async function countTotalDrivers(req, res) {
        const outObj = await driverService.getDriverCount();
        return ResponseHelper.success(res, "All Counts Fetched", outObj);
}


/* 
 *  All Drivers Detail 
*/
async function allDriverMiniDetails(req, res) {
        const driversWithBookingCounts = await driverService.getAllDriversWithStats();
        return ResponseHelper.success(res, "Drivers Details fetched", driversWithBookingCounts);
}


/* 
 *  All Drivers Detail 
*/
async function driverStatusChange(req, res) {
    const { driverId } = req.params;
    const result = await driverService.changeDriverStatus(driverId, false);
    return ResponseHelper.success(res, "Driver Status Updated", result);
}



/* 
 *   Specific Driver Detail  
*/
async function specificdriverDetail(req, res) {
    const { driverId } = req.params;
    const result = await driverService.getSpecificDriverDetails(driverId);
    return ResponseHelper.success(res, `All booking Fetched for Driver id:${driverId}`, result);
}

/*
 * Update Driver
*/
async function updateDriver(req, res) {
    const { driverId } = req.params;
    const { firstName, lastName, email, phoneNum, status } = req.body;
    
    const updateData = { firstName, lastName, email, phoneNum, status };
    const result = await driverService.updateDriver(driverId, updateData);
    return ResponseHelper.success(res, "Driver updated successfully", result);
}

//!----------------------------------------------------Orders Management-------------------------------------------------------------->>

/* 
 *  All Orders Counts
*/
async function ordersCount(req, res) {
        const outObj = await orderService.getOrderCount();
        return ResponseHelper.success(res, "All Order Count", outObj);
}


/*
  * All Order Details - Optimized Version
*/
async function allOrderDetails(req, res) {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const statusFilter = req.query.status;
        const dateFilter = req.query.date;

        const filters = {};
        if (statusFilter) filters.status = statusFilter;
        if (dateFilter) filters.date = dateFilter;

        const outObj = await orderService.getAllOrderDetails(filters, page, limit);
        return ResponseHelper.success(res, "All booking Details Fetched", outObj);
}



/*
  * Pending Orders - Optimized Version
*/
async function pendingOrders(req, res) {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const outObj = await orderService.getPendingOrders(page, limit);
        return ResponseHelper.success(res, "All Pending Orders", outObj);
}




/*
  * Cancel Orders - Optimized Version
*/
async function allCancelOrders(req, res) {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = await orderService.getCancelledOrders(page, limit);
    return ResponseHelper.success(res, "All Cancel Orders Details", result);
}




/*
  * Complete Orders - Optimized Version
*/
async function completeOrders(req, res) {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = await orderService.getCompletedOrders(page, limit);
    return ResponseHelper.success(res, "All Completed Orders", result);
}

/*
  * Edit Order - Comprehensive Order Management
*/
async function editOrder(req, res) {
    const { orderId } = req.params;
    const orderData = req.body;
    const result = await orderService.editOrder(orderId, orderData);
    return ResponseHelper.success(res, "Order updated successfully", result);
}

/*
  * Get Single Order Details for Editing
*/
async function getOrderForEdit(req, res) {
    const { orderId } = req.params;
    const result = await orderService.getOrderForEdit(orderId);
    return ResponseHelper.success(res, "Order details fetched successfully", result);
}


//!---------------------------------Service Management--------------------------------------->>

/*
  * Get Admin Service Types
*/
async function getAdminServicesWithCategories(req, res) {
    
        const outObj = await serviceManagementService.getAdminServicesWithCategories();
        return ResponseHelper.success(res, "All Services with Count Fetched", outObj);
    
}


/*
  * Add Service types
*/
async function addServiceTypes(req, res) {
    const { name, description } = req.body
    let CategoryImg = null;

    if (req.file) {

        let tempImage = req.file.path;
        CategoryImg = tempImage.replace(/\\/g, "/")

    }

    const category = await categories.create({
        name,
        description,
        image: CategoryImg,
    })

    return ResponseHelper.success(res, "Service Type Added Successfully", category);


}



/*
  * Get SubCategories/Items
*/

async function getSubCategories(req, res) {
    
        const { categoryId } = req.params;
        const outObj = await serviceManagementService.getSubCategories(categoryId);
        return ResponseHelper.success(res, "All Items fetched", outObj);

}

/*
  * Get All Services and Categories for Order Edit
*/
async function getServicesAndCategoriesForOrderEdit(req, res) {
    const result = await serviceManagementService.getServicesAndCategoriesForOrderEdit();
    return ResponseHelper.success(res, "Services and Categories fetched successfully", result);
}


/*
  * Add SubCategories/Items
*/
async function addServiceItems(req, res) {
    const { name, price, categoryId } = req.body

    const createSubCategory = await subCategories.create({
        name,
        price,
        categoryId,
        status: true
    })

    return ResponseHelper.success(res, "SubCategory Added Successfully", createSubCategory);
}

//!----------------------------------------------------Employee Management--------------------------------------->>

/* 
 *  Get Admin Employee
*/
async function getAdminEmployess(req, res) {

    const adminEmployees = await users.findAll({
        where: {
            classifiedAsId: 2,
            status: true
        },
        attributes: ['id', 'firstName', 'lastName', 'email', 'classifiedAsId', 'roleId', 'phoneNum', 'status']
    })

    let outObj = {
        adminEmployees: adminEmployees
    }


    return ResponseHelper.success(res, "Admin Employees", outObj);

}

/* 
 *  Add Admin Employee
*/
async function addEmployee(req, res) {
    const { firstName, lastName, email, password, phoneNum, roleId, zoneId } = req.body;
    const adminId = req.user.id;
    const employeeData = { firstName, lastName, email, password, phoneNum, roleId, zoneId };
    const result = await employeeManagementService.addEmployee(employeeData, adminId);
    return ResponseHelper.success(res, "Employee Added Successfully", result);
}


/*
  * Update Employee
*/
async function updateEmployee(req, res) {
    const { firstName, lastName, email, phoneNum, roleId, updatePassword, employeeId } = req.body;
    const updateData = { firstName, lastName, email, phoneNum, roleId, updatePassword, employeeId };
    const result = await employeeManagementService.updateEmployee(updateData);
    return ResponseHelper.success(res, "Employee Updated Successfully", result);
}


/*
    * Change Employee status
*/
async function changeEmployeeStatus(req, res) {
    const { status, employeeId } = req.body;
    const result = await employeeManagementService.changeEmployeeStatus(employeeId, status);
    return ResponseHelper.success(res, "Employee Status Updated", result);
}

/*
 * Add Agent Employee
 */
async function addAgentEmployee(req, res) {
    const {
        firstName,
        lastName,
        email,
        password,
        phoneNum,
        countryCode,
        roleId,
    } = req.body;

    const agentId = req.user.id;

    let profileImg = null;
    if (req.file) {
        let tempProfileImg = req.file.path;
        profileImg = tempProfileImg.replace(/\\/g, "/");
    }

    const employeeData = {
        firstName,
        lastName,
        email,
        password,
        phoneNum,
        countryCode,
        roleId,
    };

    const result = await employeeManagementService.addAgentEmployee(employeeData, profileImg, agentId);
    return ResponseHelper.success(res, "Employee Added Successfully", result);
}

/*
 * Update Agent Employee
 */
async function updateAgentEmployee(req, res) {
    const {
        firstName,
        lastName,
        email,
        phoneNum,
        roleId,
        updatePassword,
        employeeId
    } = req.body;

    let profileImg = null;
    if (req.file) {
        const tempProfileImg = req.file.path;
        profileImg = path.join('Public', 'Profile', path.basename(tempProfileImg));
        profileImg = profileImg.replace(/\\/g, "/");
    }

    const updateData = {
        firstName,
        lastName,
        email,
        phoneNum,
        roleId,
        updatePassword,
        employeeId
    };

    const result = await employeeManagementService.updateAgentEmployee(updateData, profileImg);
    return ResponseHelper.success(res, "Employee Updated Successfully", result);
}

/*
 * Change Agent Employee Status
 */
async function changeAgentEmployeeStatus(req, res) {
    const { status, employeeId } = req.body;
    const result = await employeeManagementService.changeAgentEmployeeStatus(employeeId, status);
    return ResponseHelper.success(res, "Employee Status Updated", result);
}

/*
 * Get All Agent Employees
 */
async function getAllAgentEmployees(req, res) {
    const agentId = req.user.id;
    const result = await employeeManagementService.getAllAgentEmployees(agentId);
    return ResponseHelper.success(res, "All Employee Fetched", result);
}
//!------------------------Admin Create Roles,Classicifations,Permissions-------------------------//

/*
   * Add Roles
*/

async function addRole(req, res) {
    const { name, permissionRole } = req.body;
    const roleData = { name, permissionRole };
    const result = await roleManagementService.addRole(roleData);
    return ResponseHelper.success(res, "Role and Permission Added Successfully", result);
}


/*
   * Update Roles
*/
async function updateRoles(req, res) {
    const { name, permissionRole, roleId } = req.body;
    const updateData = { name, permissionRole };
    const result = await roleManagementService.updateRole(roleId, updateData);
    return ResponseHelper.success(res, "Role updated", result);
}


/*
  * Get All Roles
*/
async function getAllRoles(req, res) {
    const getRoles = await roleManagementService.getAllRoles();
    return ResponseHelper.success(res, "Get All Roles", getRoles);
}

/*
   * Add Classified
*/
async function addClassifiedAs(req, res) {
    const { name } = req.body;
    const classifiedData = { name };
    const result = await featureManagementService.addClassifiedAs(classifiedData);
    return ResponseHelper.success(res, "Added the classified As", result);
}


/*
   * Get ClassifiedAs
*/
async function getClassifiedAs(req, res) {
    const findData = await featureManagementService.getClassifiedAs();
    return ResponseHelper.success(res, "Fetched All ClassifiedAs Roles", findData);
}



/*
   * Add Features
*/
async function addfeatures(req, res) {
    const { title, status, featureOf, key } = req.body;
    const featureData = { title, status, featureOf, key };
    const result = await featureManagementService.addFeature(featureData);
    return ResponseHelper.success(res, "Feature Added", result);
}


/*
   * Get Features
*/
async function getFeatures(req, res) {
    const findFeature = await featureManagementService.getFeatures();
    return ResponseHelper.success(res, "All Features Fetched", findFeature);
}


//!------------------------------------------------------------Shop Management------------------------------------------------->>>>>>>

/*
   * Shop Counts
*/
async function getShopInformation(req, res) {

        const outObj = await shopManagementService.getShopInformation();
        return ResponseHelper.success(res, "Shops Information Fetched", outObj);

}


/*
   * All Shops Data
*/
async function shopsData(req, res) {

        const outObj = await shopManagementService.getShopsData();
        return ResponseHelper.success(res, "Shop Information Data", outObj);

}

/*
   * Single Shops Data
*/
async function singleShopData(req, res) {

        const { Id } = req.params;
        const shopData = await shopManagementService.getSingleShopData(Id);
        return ResponseHelper.success(res, "Single Shop Data", shopData);

}


/*
   * Get Shop Employees
*/
async function getShopEmployees(req, res) {

        const { bussinessId } = req.params;
        const findEmployees = await shopManagementService.getShopEmployees(bussinessId);
        return ResponseHelper.success(res, "Employee Data Fetched", findEmployees);

}


//!----------------------------------------------------Add Countries,Cities,Zones && Zone Details--------------------------------------->>
/* 
 *  Add Countries
*/
async function addCountries(req, res) {
    const { name, shortName } = req.body;

    let flagImg = null;
    if (req.file) {
        let tempImage = req.file.path;
        flagImg = tempImage.replace(/\\/g, "/");
    }

    const countryData = { name, code: shortName, image: flagImg };
    const result = await locationManagementService.addCountry(countryData);
    return ResponseHelper.success(res, "Country Added Successfully", result);
}

/*
   * Get Countries
*/
async function getCountries(req, res) {
    const getCountry = await locationManagementService.getCountries();
    return ResponseHelper.success(res, "All Countries fetched", getCountry);
}


/*
   * Add Cities
*/

async function addCities(req, res) {
    const { name, lat, lng, countryId } = req.body;
    const cityData = { name, lat, lng, countryId };
    const result = await locationManagementService.addCity(cityData);
    return ResponseHelper.success(res, "City Added Successfully", result);
}

/*
   * Get Cities
*/
async function getCities(req, res) {
    const getCities = await locationManagementService.getCities();
    return ResponseHelper.success(res, "All Cities Fetched", getCities);
}

/*
 * Get Cities by Country Id
*/
async function getCitiesByCountryId(req, res) {
    const { countryId } = req.params;
    const getCities = await dataService.getCitiesByCountryId(countryId);
    return ResponseHelper.success(res, "All Cities Fetched", getCities);
}


/*
   * Add Zones
*/

async function addZones(req, res) {
    const { name, coordinates, cityId, zoneMinimumAmount, currencyUnitId, distanceUnitId, serviceCharge, zoneAdminComission } = req.body;

    const polygon = {
        type: 'Polygon',
        coordinates: coordinates
    };

    const zoneData = {
        name,
        coordinates: polygon,
        cityId,
        zoneMinimumAmount,
        currencyUnitId,
        distanceUnitId,
        serviceCharge,
        zoneAdminComission: zoneAdminComission ? zoneAdminComission : 20
    };

    const zoneCreate = await zoneManagementService.addZone(zoneData);
    return ResponseHelper.success(res, "Zone Added Successfully", zoneCreate);
}


/*
   * Get Zones
*/

async function getZones(req, res) {
    const shapedZones = await zoneManagementService.getZones();
    return ResponseHelper.success(res, "All Zones Fetched Successfully", shapedZones);
}


/*
 * Update Zone
*/

async function updateZone(req, res) {
    const { name, coordinates, cityId, zoneMinimumAmount, currencyUnitId, distanceUnitId, serviceCharge, zoneAdminComission } = req.body;
    const { zoneId } = req.params;

    const polygon = {
        type: 'Polygon',
        coordinates: coordinates
    };

    const updateData = {
        name,
        coordinates: polygon,
        cityId,
        zoneMinimumAmount,
        currencyUnitId,
        distanceUnitId,
        serviceCharge,
        zoneAdminComission: zoneAdminComission ? zoneAdminComission : 20
    };

    const updateZone = await zoneManagementService.updateZone(zoneId, updateData);
    return ResponseHelper.success(res, "Zone Updated Successfully", updateZone);
}







/*
 * Delete Zone
*/
async function deleteZone(req, res) {
    const { zoneId } = req.query;

    if (!zoneId) {
        return ResponseHelper.validationError(res, "zoneId is required");
    }

    const result = await zoneManagementService.deleteZone(zoneId);
    return ResponseHelper.success(res, "Zone deleted successfully (soft delete)", result);
}


//!-----------------------Units Management--------------------//
async function getUnitsDistanceAndCurrency(req, res) {

        const getUnits = await dataService.getUnitsDistanceAndCurrency();
        return ResponseHelper.success(res, "All Units Fetched", getUnits);

}
async function getAllUnits(req, res) {

        const getUnits = await dataService.getAllUnits();
        return ResponseHelper.success(res, "All Units Fetched", getUnits);

}
//!-----------------------Add Services,Categories and SubCategories --------------------//
/*

*  Add Services

*/
async function AddServices(req, res) {

        const { name, description } = req.body;

        let serviceImg = null;

        if (req.file) {
            let tempImage = req.file.path;
            serviceImg = tempImage.replace(/\\/g, "/");
        }

        const serviceData = {
            name,
            description,
            image: serviceImg,
        };

        const serviceCreate = await serviceManagementService.addService(serviceData);

        return ResponseHelper.success(res, "Services Added Successfully", serviceCreate);
}


/*
*  Get All Services
*/
async function getAllServices(req, res) {

        const result = await serviceManagementService.getAllServices();
        console.log("🚀 ~ getAllServices ~ result:", result)
        return ResponseHelper.success(res, "All Services", result);

}


/*
  * Delete Services
*/
async function deleteServices(req, res) {
    const { serviceId } = req.params;
    const deleteService = await serviceManagementService.deleteService(serviceId);
    return ResponseHelper.success(res, "Service Deleted Successfully", deleteService);
}


/*
  * Edit Services
*/
async function editServices(req,res){
    const { serviceId } = req.params;
    const { name, description } = req.body;

    let serviceImg = null;

        if (req.file) {
            let tempImage = req.file.path;
            serviceImg = tempImage.replace(/\\/g, "/");
        }
    const editService = await serviceManagementService.editService(serviceId, name, description, serviceImg);
    return ResponseHelper.success(res, "Service Edited Successfully", editService);
}


/*
  * Add Categories
*/
async function AddCategories(req, res) {
    const { name, description } = req.body

    let CategoryImg = null;

    if (req.file) {

        let tempImage = req.file.path;
        CategoryImg = tempImage.replace(/\\/g, "/")

    }

    const categoryData = {
        name,
        description,
        image: CategoryImg,
    }

    const category = await serviceManagementService.addCategory(categoryData);

    return ResponseHelper.success(res, "Category Added Successfully", category);

}




/*
  * Get All Categories
*/
async function getCategories(req, res) {

        const getCategories = await serviceManagementService.getCategories();
        return ResponseHelper.success(res, "All Categories Fetched", getCategories);

}

/*
  * Edit Categories
*/
async function editCategories(req, res) {
    const { categoryId } = req.params;
    const { name, description } = req.body;
    const editCategory = await serviceManagementService.editCategories(categoryId, name, description);
    return ResponseHelper.success(res, "Category Edited Successfully", editCategory);
}

/*
  * Delete Categories
*/
async function deleteCategories(req, res) {
    const { categoryId } = req.params;
    const deleteCategory = await serviceManagementService.deleteCategories(categoryId);
    return ResponseHelper.success(res, "Category Deleted Successfully", deleteCategory);
}


/*
  * Assign Services to Categories
*/
async function serviceCategoriesAssign(req, res) {
    const { serviceId, categoryId } = req.body;
    const result = await serviceManagementService.assignServiceToCategories(serviceId, categoryId);
    return ResponseHelper.success(res, "Service assigned to categories successfully.", { createData: result });
}






/*
  * Add SubCategories
*/
async function addSubCategories(req, res) {
    const categoryData = req.body;
    const result = await serviceManagementService.addSubCategoriesWithBarcode(categoryData, generateBarcodeforSubCategories);
    return ResponseHelper.success(res, "SubCategories Added Successfully", result);
}


/*
  * Get SubCategories
*/
async function getSubcategories(req, res) {

        const getSubcategories = await serviceManagementService.getSubcategories();
        return ResponseHelper.success(res, "All SubCategories Fetched", getSubcategories);

}

/*
  * Edit SubCategories
*/

async function editSubCategories(req, res) {
    const { subCategoryId } = req.params;
    const { name, price } = req.body;
    const editSubCategory = await serviceManagementService.editSubcategories(subCategoryId, name, price);
    return ResponseHelper.success(res, "SubCategory Edited Successfully", editSubCategory);
}


/*
  * Delete SubCategories
*/
async function deleteSubCategories(req, res) {
    const { subCategoryId } = req.params;
    const deleteSubCategory = await serviceManagementService.deleteSubcategories(subCategoryId);
    return ResponseHelper.success(res, "SubCategory Deleted Successfully", deleteSubCategory);
}


//!-----------------------------------Driver && Vechicles------------------------------------------->>
/* 
 *  Add vehicle
*/

async function addVehicle(req, res) {
    let { title, baseRate, perUnitRate, weightCapacity, volumeCapacity } = req.body;
    
    const appUnitId = await currentAppUnitsId();
    const units = await unitsSymbolsAndRates(appUnitId);
    weightCapacity = convertToBaseUnits(weightCapacity, units.conversionRate.weight);
    volumeCapacity = convertToBaseUnits(volumeCapacity, units.conversionRate.length);
    
    let imagePath = "";
    if (req.file) {
        let tmpPath = req.file.path;
        imagePath = tmpPath.replace(/\\/g, "/");
    }
    
    const vehicleData = {
        title,
        baseRate,
        perUnitRate,
        weightCapacity,
        volumeCapacity,
        image: imagePath
    };
    
    const result = await vehicleManagementService.addVehicle(vehicleData);
    return ResponseHelper.success(res, "Vehicle added", result);
}

//!----------------------------------Cancel Booking Reasons---------------------------------//
/*
  *  Cancel Booking Reasons
*/
async function cancelBooking(req, res) {
    const { cancelReason } = req.body
    const reasonCreate = await reason.create({
        cancelReason
    })
    return ResponseHelper.success(res, "Reason Added", reasonCreate);

}


/*
  *  Get All Cancel Booking Reasons
*/

async function getCancelBookingReasons(req, res) {

        const getBooking = dataService.getCancelBookingReasons();
        return ResponseHelper.success(res, "All Cancel Booking reasons fetched", getBooking);

}

//!------------------------Admin Create Roles,Classicifations,Permissions-------------------------//
async function laundryRoles(req, res) {
    const { name, status } = req.body
    const roleCreation = await roles.create({
        name,
        status
    })

    return ResponseHelper.success(res, "Roles Added Successfully", roleCreation);

}




//!--------------------------------------------Add Machines-----------------------------------------------//
/*
  * Add Machines
*/

async function addMachines(req, res) {
    const { name } = req.body

    const findMachine = await machines.findOne({
        where: {
            name: name
        }
    })
    if (findMachine) {
        throw new customError("Machine Already Exists")
    }
    const createMachine = await machines.create({
        name,
        status: true
    })
    return ResponseHelper.success(res, "Machine Added", createMachine);

}



//!-----------------------------Add Match Preferences-------------------------//
/*
  * Add Preference Types
*/
async function createPreferenceType(req, res) {
    const { name } = req.body

    const findPreferenceType = await preferenceTypes.findOne({
        where: {
            name: name,
            status: true
        }
    })

    if (findPreferenceType) {
        throw new customError('Preference Type Already Exists')
    }

    const createPreferenceType = await preferenceTypes.create({
        name,
        status: true
    })

    return ResponseHelper.success(res, "Preference Type Added", { createPreferenceType });

}

/*
 * Edit Preference Type
*/
async function editPreferenceType(req, res) {
    const { preferenceTypeId } = req.params;
    const { name } = req.body;
    const editPreferenceType = await prefrencesServices.editPreferenceType(preferenceTypeId, name);
    return ResponseHelper.success(res, "Preference Type Edited", editPreferenceType);
}

/*
 * Delete Preference Type
*/
async function deletePreferenceTypeController(req, res) {
    const { preferenceTypeId } = req.params;
    const deletePreferenceType = await prefrencesServices.deletePreferenceType(preferenceTypeId);
    return ResponseHelper.success(res, "Preference Type Deleted", deletePreferenceType);
}

/*
  * Add Preference Values
*/
async function addPreferenceValues(req, res) {
    const { value, preferenceTypeId } = req.body;
    const result = await prefrencesServices.addPreferenceValues(value, preferenceTypeId);
    return ResponseHelper.success(res, `${result.count} Preference Value(s) Added`, { createdValues: result.createdValues });
}

/*
 * Edit Preference Values
*/
async function editPreferenceValuesController(req, res) {
    const { preferenceValueId } = req.params;
    const { value } = req.body;
    const editPreferenceValuesData = await prefrencesServices.editPreferenceValues(preferenceValueId, value);
    return ResponseHelper.success(res, "Preference Values Edited", editPreferenceValuesData);
}


/*
 * Delete Preference Values
*/
async function deletePreferenceValuesController(req, res) {
    const { preferenceValueId } = req.params;
    const deletePreferenceValuesData = await prefrencesServices.deletePreferenceValues(preferenceValueId);
    return ResponseHelper.success(res, "Preference Values Deleted", deletePreferenceValuesData);
}

/*
  * Add Service With Preferences
*/
async function addServiceWithPreferences(req, res) {
    const { serviceId, preferenceTypeId } = req.body;
    const result = await prefrencesServices.addServiceWithPreferences(serviceId, preferenceTypeId);
    return ResponseHelper.success(res, `${result.count} Service(s) mapped to Preference`, { createdMappings: result.createdMappings });
}


/*
  * Get Preference Types
*/
async function getPreferenceTypes(req, res) {
        const getPreferenceTypes = await dataService.getPreferenceTypes();
        return ResponseHelper.success(res, "All Preference Types Fetched", getPreferenceTypes);
    
}


/*
  * Get Preferences And Services Data
*/
async function servicesAndPreferencesData(req,res) {
    const {serviceId}=req.params
    const getData=await serviceManagementService.getAllPreferenceTypesAndServiceDetails(serviceId)
    return ResponseHelper.success(res,"All Preferences and Services Data Fetched",getData)
    
}



/*
  * UnAssign Service From Preferences
*/
async function unAssignServiceFromPreferences(req, res) {
    const { serviceId } = req.params;
    const result = await serviceManagementService.unAssignServiceFromPreferences(serviceId);
    return ResponseHelper.success(res, "Service Unassigned From Preferences", result);
}

//!------------------------On Hold Options-------------------//

/*
  * Add On Hold Options
*/
async function onHoldOptions(req, res) {
    const { option } = req.body

    const optionValues = option.map(item => item.option);
    console.log("🚀 ~ onHoldOptions ~ optionValues:", optionValues)

    const optionFind = await onHoldOption.findAll({
        where: {
            option: optionValues
        }
    })
    console.log("🚀 ~ onHoldOptions ~ optionFind:", optionFind)

    if (optionFind.length > 0) {
        throw new customError('Some Options Already Exists')
    }

    const optionsCreate = await onHoldOption.bulkCreate(
        option.map(opt => ({
            option: opt.option,
            status: true
        }))
    );

    return ResponseHelper.success(res, "on Hold Options Created", optionsCreate);


}


/*
  * Get On Hold Options
*/

async function getOnHoldOptions(req, res) {

        const getOptions = await dataService.getOnHoldOptions();
        return ResponseHelper.success(res, "All on Hold Options Fetched", getOptions);

}




/*
  * Add On Hold Customer Options
*/
async function customerOnHoldOptions(req, res) {
    const { option, onHoldOptionId } = req.body

    const optionValues = option.map(item => item.option);

    const optionFind = await onHoldCustomerOption.findAll({
        where: {
            option: optionValues
        }
    })
    console.log("🚀 ~ customerOnHoldOptions ~ optionFind:", optionFind)

    if (optionFind.length > 0) {
        throw new customError('Some Options Already Exists')
    }

    const optionsCreate = await onHoldCustomerOption.bulkCreate(
        option.map(opt => ({
            title: opt.title,
            option: opt.option,
            conformationText: opt.confirmationText,
            notConfirmText: opt.notConfirmText,
            onHoldOptionId: opt.onHoldOptionId,
            status: true
        }))
    )


    return ResponseHelper.success(res, "Customer Hold Option", optionsCreate);
}


/*
  * Get On Hold Customer Options
*/
async function getOnHoldCustomerOptions(req, res) {

        const optionsFound = dataService.getOnHoldCustomerOptions();
        return ResponseHelper.success(res, "All Options Fetched", optionsFound);

}

/*
  * Get All On Hold Bookings
*/
async function getOnHoldBookings(req, res) {
    const optionsFound = orderService.getOnHoldBookings();
    return ResponseHelper.success(res, "All Options Fetched", optionsFound);
}

//!===================================================Recurring functions=======================================//
let responsefunc = (status, message, data, error) => {
    return {
        status: `${status}`,
        message: `${message}`,
        data: data,
        error: `${error}`
    }
}

// Helper function for optimized booking queries
async function getOptimizedBookings(whereClause, page = 1, limit = 50) {
    const offset = (page - 1) * limit;

    // Get total count
    const totalCount = await booking.count({ where: whereClause });

    // Get bookings with optimized includes
    const bookings = await booking.findAll({
        where: whereClause,
        include: [
            {
                model: customerSelectedService,
                attributes: ['id', 'date', 'time', 'items', 'serviceId', 'categoryPrice'],
                include: [
                    {
                        model: service,
                        attributes: ['id', 'name', 'status']
                    },
                    {
                        model: categories,
                        attributes: ['id', 'name']
                    }
                ]
            },
            {
                model: OnHoldConfirmation,
                required: false,
                attributes: ['onHoldImg', 'noOfItems', 'description', 'bookingId']
            },
            {
                model: addressDb,
                as: 'laundryShop',
                include: {
                    model: bussinessInformation,
                    attributes: ['shopName']
                },
                attributes: ['id']
            },
            {
                model: bookingStatus,
                attributes: ['title', 'description']
            }
        ],
        order: [['id', 'DESC']],
        limit: limit,
        offset: offset,
        attributes: {
            exclude: ['updatedAt', 'categoryId', 'serviceId', 'subCategoryId', 'vehicleTypeId']
        },
        logging: false,
        benchmark: false
    });

    // Calculate pagination info
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    return {
        bookings,
        totalCount,
        pagination: {
            currentPage: page,
            totalPages: totalPages,
            totalRecords: totalCount,
            recordsPerPage: limit,
            hasNextPage: hasNextPage,
            hasPrevPage: hasPrevPage
        }
    };
}

function generateBarcodeforSubCategories(name, price, fileName) {
    const canvas = createCanvas(800, 300); // Wider + taller canvas
    const barcodeData = `${name.replace(/\s/g, '')}-${price}`;

    JsBarcode(canvas, barcodeData, {
        format: "CODE128",
        width: 3,
        height: 200,
        displayValue: false,
        fontSize: 20,
        margin: 20,
    });

    const buffer = canvas.toBuffer("image/png");

    const dirPath = path.join(__dirname, "..", "..", "Public", "BarCodeImages");
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    const filePath = path.join(dirPath, fileName);
    fs.writeFileSync(filePath, buffer);

    return `Public/BarCodeImages/${fileName}`;
}


function calculateZoneRadius(polygon) {
    if (!polygon || !polygon.coordinates || !polygon.coordinates[0]) return 0;

    const points = polygon.coordinates[0].map(([lng, lat]) => ({ latitude: lat, longitude: lng }));

    const center = geolib.getCenter(points);
    const maxDistance = Math.max(...points.map(point => geolib.getDistance(center, point))); // in meters

    return (maxDistance / 1000).toFixed(2); // return km
}



//!-------------------Exports----------------//
module.exports = {
    //-------------Admin Dashboard--------//
    adminDashboard,
    //-------------Vehicles--------//
    addVehicle,
    //-------------Countries,Cities--------//
    addCountries,
    addCities,
    getCities,
    getCitiesByCountryId,
    getCountries,
    //-------------Add Zones--------//
    addZones,
    getZones,
    deleteZone,
    updateZone,
    //-------------Units--------//
    getUnitsDistanceAndCurrency,
    //-------------Categories,SubCategories--------//
    AddCategories,
    addSubCategories,
    getCategories,
    getSubcategories,
    serviceCategoriesAssign,
    editSubCategories,
    editCategories,
    deleteCategories,
    deleteSubCategories,
    //-------------Services--------//
    getAllServices,
    AddServices,
    deleteServices,
    editServices,
    //-------------Units--------//
    getUnitsDistanceAndCurrency,
    getAllUnits,
    //-------------Cancel Booking--------//
    cancelBooking,
    getCancelBookingReasons,
    //-------------Laundry Roles--------//
    laundryRoles,
    //-------------Machinery--------//
    addMachines,
    //------------Account Preferences-----------//
    editPreferenceType,
    deletePreferenceTypeController,
    createPreferenceType,
    addPreferenceValues,
    editPreferenceValuesController,
    deletePreferenceValuesController,
    addServiceWithPreferences,
    getPreferenceTypes,
    servicesAndPreferencesData,
    unAssignServiceFromPreferences,
    //--------on Hold Option------------//
    onHoldOptions,
    customerOnHoldOptions,
    getOnHoldCustomerOptions,
    getOnHoldOptions,
    getOnHoldBookings,
    //------------Customer Management-------//
    getAllCustomers,
    customerCount,
    specificCustomerDetails,
    updateCustomer,
    deleteCustomer,
    //-----------Driver Management----------//
    countTotalDrivers,
    allDriverMiniDetails,
    driverStatusChange,
    specificdriverDetail,
    updateDriver,
    //----------Order Management------------//
    ordersCount,
    allOrderDetails,
    pendingOrders,
    allCancelOrders,
    completeOrders,
    editOrder,
    getOrderForEdit,
    //----------Service Management---------//
    getAdminServicesWithCategories,
    addServiceTypes,
    getSubCategories,
    addServiceItems,
    getServicesAndCategoriesForOrderEdit,
    //----------Employee Management---------//
    getAdminEmployess,
    addEmployee,
    updateEmployee,
    changeEmployeeStatus,
    addAgentEmployee,
    updateAgentEmployee,
    changeAgentEmployeeStatus,
    getAllAgentEmployees,
    //----------Add,Roles,Permissions && Features ---------//
    addRole,
    updateRoles,
    getAllRoles,
    addClassifiedAs,
    getClassifiedAs,
    addfeatures,
    getFeatures,
    //------------Shop Management-----------//
    getShopInformation,
    shopsData,
    singleShopData,
    getShopEmployees
}
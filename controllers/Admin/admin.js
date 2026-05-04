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
    postcodeZoneService,
    vehicleManagementService,
    roleManagementService,
    cancellationPolicyService: cancellationPolicyServiceImport,
    noShowPolicyService,
    reschedulePolicyService,
    activePoliciesService,
    featureManagementService,
    locationManagementService,
    agentRegistrationService,
    reasonService,
    addOnServicesService
} = require('../../services/Admin');

// Import FAQ and Blog services
const faqService = require('../../services/Admin/faqService');
const blogService = require('../../services/Admin/blogService');
const supportContactService = require('../../services/Admin/supportContactService');
const customerOrderService = require('../../services/Customer/customerOrderService');

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
    const data = { ...req.body };
    const result = await customerService.updateCustomer(customerId, data);
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
    const { 
        firstName, 
        lastName, 
        email, 
        password,
        phoneNum, 
        countryCode,
        status 
    } = req.body;

    // Handle profile image upload
    let profileImg = null;
    if (req.file) {
        let tempProfileImg = req.file.path;
        profileImg = tempProfileImg.replace(/\\/g, "/");
    }

    const data = {
        firstName,
        lastName,
        email,
        password,
        phoneNum,
        countryCode,
        status
    };

    const result = await driverService.updateDriver(driverId, data, profileImg);
    return ResponseHelper.success(res, "Driver updated successfully", result);
}

/*
 * Delete Driver
*/
async function deleteDriver(req, res) {
    const { driverId } = req.params;
    const result = await driverService.deleteDriver(driverId);
    return ResponseHelper.success(res, "Driver deleted successfully", result);
}

/*
 * Add Driver by Laundry Shop ID
*/
async function addDriverByLaundryShop(req, res) {
    const {
        firstName,
        lastName,
        email,
        password,
        phoneNum,
        countryCode,
        roleId,
        laundaryShopId
    } = req.body;

    // Handle profile image upload
    let profileImg = null;
    if (req.file) {
        let tempProfileImg = req.file.path;
        profileImg = tempProfileImg.replace(/\\/g, "/");
    }

    const data = {
        firstName,
        lastName,
        email,
        password,
        phoneNum,
        countryCode,
        roleId: roleId || 6,
        laundaryShopId
    };

    const result = await driverService.addDriverByLaundryShop(data, profileImg);
    return ResponseHelper.success(res, "Driver added successfully", result);
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

/*
  * Get service details + booking selected services
*/
async function getServiceDetailWithBookingSelection(req, res) {
    const { bookingId } = req.params;
    const result = await orderService.getServiceDetailWithBookingSelection(bookingId);
    return ResponseHelper.success(res, "Service details with booking selection fetched successfully", result);
}

/*
  * Delete Order (Soft Delete)
*/
async function deleteOrder(req, res) {
    const { orderId } = req.params;
    const result = await orderService.deleteOrder(orderId);
    return ResponseHelper.success(res, "Order deleted successfully", result);
}

/*
 * Admin Update Invoice
 * Service-controller approach (logic in orderService).
 */
async function updateInvoice(req, res) {
    const result = await orderService.updateInvoice(req.body);
    return ResponseHelper.success(res, "Invoice updated successfully", result);
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
    const { name, description } = req.body;
    let CategoryImg = null;

    if (req.file) {
        let tempImage = req.file.path;
        CategoryImg = tempImage.replace(/\\/g, "/")
    }

    const data = { ...req.body };
    if (CategoryImg) {
        data.image = CategoryImg;
    }

    const category = await categories.create(data);

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
    const { name, price, categoryId } = req.body;
    const data = { ...req.body, status: true };
    const createSubCategory = await subCategories.create(data);
    return ResponseHelper.success(res, "SubCategory Added Successfully", createSubCategory);
}

//!----------------------------------------------------Employee Management--------------------------------------->>

/* 
 *  Get Admin Employee
*/
async function getAdminEmployess(req, res) {

    const adminEmployees = await employeeManagementService.getAdminEmployees();

    return ResponseHelper.success(res, "Admin Employees", adminEmployees);

}

/* 
 *  Add Admin Employee
*/
async function addEmployee(req, res) {
    const { firstName, lastName, email, password, phoneNum, roleId, zoneId } = req.body;
    const adminId = req.user.id;
    const data = { ...req.body };
    const result = await employeeManagementService.addEmployee(data, adminId);
    return ResponseHelper.success(res, "Employee Added Successfully", result);
}


/*
  * Update Employee
*/
async function updateEmployee(req, res) {
    const { firstName, lastName, email, phoneNum, roleId, updatePassword, employeeId } = req.body;
    const data = { ...req.body };
    const result = await employeeManagementService.updateEmployee(data);
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
 * Get Specific Admin Employee
 */
async function getAdminEmployeeDetail(req, res) {
    const { employeeId } = req.params;

    if (!employeeId) {
        return ResponseHelper.error(res, "Employee ID is required", 400);
    }

    const result = await employeeManagementService.getAdminEmployeeDetail(employeeId);
    return ResponseHelper.success(res, "Admin Employee Detail", result);
}

/*
 * Update Admin Employee
 */
async function updateAdminEmployee(req, res) {
    const { employeeId } = req.body;

    if (!employeeId) {
        return ResponseHelper.error(res, "Employee ID is required", 400);
    }

    const data = { ...req.body };
    const result = await employeeManagementService.updateAdminEmployee(data);
    return ResponseHelper.success(res, "Admin Employee Updated Successfully", result);
}

/*
 * Delete Admin Employee (Soft Delete)
 */
async function deleteAdminEmployee(req, res) {
    const { employeeId } = req.params;

    if (!employeeId) {
        return ResponseHelper.error(res, "Employee ID is required", 400);
    }

    const result = await employeeManagementService.deleteAdminEmployee(employeeId);
    return ResponseHelper.success(res, "Admin Employee Deleted Successfully", result);
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
        agentId,
    } = req.body;

    if (!agentId) {
        return ResponseHelper.error(res, "Agent ID is required", 400);
    }

    let profileImg = null;
    if (req.file) {
        let tempProfileImg = req.file.path;
        profileImg = tempProfileImg.replace(/\\/g, "/");
    }

    const data = { ...req.body };
    const result = await employeeManagementService.addAgentEmployee(data, profileImg, agentId);
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

    if (!employeeId) {
        return ResponseHelper.error(res, "Employee ID is required", 400);
    }

    let profileImg = null;
    if (req.file) {
        const tempProfileImg = req.file.path;
        profileImg = path.join('Public', 'Profile', path.basename(tempProfileImg));
        profileImg = profileImg.replace(/\\/g, "/");
    }

    const data = { ...req.body };
    const result = await employeeManagementService.updateAgentEmployee(data, profileImg);
    return ResponseHelper.success(res, "Employee Updated Successfully", result);
}

/*
 * Change Agent Employee Status
 */
async function changeAgentEmployeeStatus(req, res) {
    const { status, employeeId } = req.body;
    
    if (!employeeId) {
        return ResponseHelper.error(res, "Employee ID is required", 400);
    }
    
    if (status === undefined || status === null) {
        return ResponseHelper.error(res, "Status is required", 400);
    }
    
    const result = await employeeManagementService.changeAgentEmployeeStatus(employeeId, status);
    return ResponseHelper.success(res, "Employee Status Updated", result);
}

/*
 * Get All Agent Employees
 */
async function getAllAgentEmployees(req, res) {
    const { agentId } = req.params;
    
    if (!agentId) {
        return ResponseHelper.error(res, "Agent ID is required", 400);
    }
    
    const result = await employeeManagementService.getAllAgentEmployees(agentId);
    return ResponseHelper.success(res, "All Employee Fetched", result);
}

/*
 * Delete Agent Employee (Soft Delete)
 */
async function deleteAgentEmployee(req, res) {
    const { employeeId } = req.params;
    
    if (!employeeId) {
        return ResponseHelper.error(res, "Employee ID is required", 400);
    }
    
    const result = await employeeManagementService.deleteAgentEmployee(employeeId);
    return ResponseHelper.success(res, "Agent Employee Deleted Successfully", result);
}


    //!----------Agent Registration Management---------//

/*
 * Register Agent (Admin Side)
 */
async function registerAgent(req, res) {
    const { 
        firstName, 
        lastName, 
        password, 
        phoneNum, 
        countryId, 
        cityId, 
        email, 
        countryCode
    } = req.body;

    // Handle profile image upload
    let profileImg = null;
    if (req.file) {
        let tempProfileImg = req.file.path;
        profileImg = tempProfileImg.replace(/\\/g, "/");
    }

    const data = {
        firstName,
        lastName,
        password,
        phoneNum,
        countryId,
        cityId,
        email,
        countryCode
    };

    const result = await agentRegistrationService.registerAgent(data, profileImg);
    return ResponseHelper.success(res, "Agent registered successfully", result);
}

/*
 * Add Business Information to Agent
 */
async function addAgentBusinessInfo(req, res) {
    const { userId } = req.params;
    const { 
        shopName, 
        matchProfileOptions, 
        otherText, 
        machineryCount, 
        serviceTimes,
        streetAddress,
        province,
        postalCode,
        district,
        lat,
        lng,
        coordinates,
        addressType,
        zoneId
    } = req.body;

    const data = { ...req.body };
    const result = await agentRegistrationService.addBusinessInformation(data, userId);
    return ResponseHelper.success(res, "Business information added successfully", result);
}

/*
 * Add Services to Agent
 */
async function addAgentServices(req, res) {
    const { userId } = req.params;
    const { services } = req.body;

    const data = { services };
    const result = await agentRegistrationService.addAgentServices(data, userId);
    return ResponseHelper.success(res, "Services added successfully", result);
}

/*
 * Update Agent Working Hours
 */
async function updateAgentWorkingHours(req, res) {
    const { userId } = req.params;
    const { bussinessWorkingDays } = req.body;

    const data = { ...req.body };
    const result = await agentRegistrationService.updateWorkingHours(data, userId);
    return ResponseHelper.success(res, "Working hours updated successfully", result);
}

/*
 * Get Agent Complete Information
 */
async function getAgentCompleteInfo(req, res) {
    const { userId } = req.params;
    
    const result = await agentRegistrationService.getAgentCompleteInfo(userId);
    return ResponseHelper.success(res, "Agent information fetched successfully", result);
}

/*
 * Add Agent Address
 */
async function addAgentAddress(req, res) {
    const { userId } = req.params;
    const {
        streetAddress,
        district,
        province,
        lat,
        lng,
        coordinates,
        addressType,
        postalcode
    } = req.body;

    const data = {
        streetAddress,
        district,
        province,
        lat,
        lng,
        coordinates,
        addressType,
        postalcode
    };

    const result = await agentRegistrationService.addAgentAddress(data, userId);
    return ResponseHelper.success(res, "Agent address added successfully", result);
}

/*
 * Edit Agent Address
 */
async function editAgentAddress(req, res) {
    const { userId } = req.params;
    const {
        streetAddress,
        district,
        province,
        lat,
        lng,
        coordinates,
        addressType,
        postalcode
    } = req.body;

    const data = {
        streetAddress,
        district,
        province,
        lat,
        lng,
        coordinates,
        addressType,
        postalcode
    };

    const result = await agentRegistrationService.editAgentAddress(data, userId);
    return ResponseHelper.success(res, "Agent address updated successfully", result);
}

/*
 * Get Agent Address
 */
async function getAgentAddress(req, res) {
    const { userId } = req.params;
    
    const result = await agentRegistrationService.getAgentAddress(userId);
    return ResponseHelper.success(res, "Agent address fetched successfully", result);
}

/*
 * Get Shop Address with Business Info
 */
async function getShopAddress(req, res) {
    const { userId } = req.params;
    
    const result = await agentRegistrationService.getShopAddress(userId);
    return ResponseHelper.success(res, "Shop address fetched successfully", result);
}
//!------------------------Admin Create Roles,Classicifations,Permissions-------------------------//

/*
   * Add Roles
*/

async function addRole(req, res) {
    const { name, permissionRole } = req.body;
    const data = { ...req.body };
    const result = await roleManagementService.addRole(data);
    return ResponseHelper.success(res, "Role and Permission Added Successfully", result);
}


/*
   * Update Roles
*/
async function updateRoles(req, res) {
    const { id, roleId, ...updateData } = req.body;
    const roleIdToUse = roleId || id;
    
    if (!roleIdToUse) {
        throw new ValidationError('Role ID is required');
    }
    
    const result = await roleManagementService.updateRole(roleIdToUse, updateData);
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
    const data = { ...req.body };
    const result = await featureManagementService.addClassifiedAs(data);
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
    const data = { ...req.body };
    const result = await featureManagementService.addFeature(data);
    return ResponseHelper.success(res, "Feature Added", result);
}


/*
   * Get Features
*/
async function getFeatures(req, res) {
    const findFeature = await featureManagementService.getFeatures();
    return ResponseHelper.success(res, "All Features Fetched", findFeature);
}


/*
   * Delete Feature
*/
async function deleteFeature(req, res) {
    const { featureId } = req.params;
    const result = await featureManagementService.deleteFeature(featureId);
    return ResponseHelper.success(res, "Feature Deleted Successfully", result);
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
   * Delete Shop (Soft Delete)
*/
async function deleteShop(req, res) {
    const { shopId } = req.params;
    const result = await shopManagementService.deleteShop(shopId);
    return ResponseHelper.success(res, "Shop deleted successfully", result);
}


/*
   * Get Shop Employees
*/
async function getShopEmployees(req, res) {

        const { bussinessId } = req.params;
        const findEmployees = await shopManagementService.getShopEmployees(bussinessId);
        return ResponseHelper.success(res, "Employee Data Fetched", findEmployees);

}

/*
 * Get All Employees with Shop Information
 */
async function getAllEmployeesWithShopInfo(req, res) {
    const result = await shopManagementService.getAllEmployeesWithShopInfo();
    return ResponseHelper.success(res, "All Employees with Shop Information Fetched", result);
}


//!---------------------------------Cancellation Policy Management--------------------------------------->>

/*
 * Create Cancellation Policy
 */
async function createCancellationPolicyController(req, res) {
    const userId = req.user.id;
    const policyData = {
        ...req.body,
        createdBy: userId
    };
    const result = await cancellationPolicyServiceImport.createCancellationPolicy(policyData);
    return ResponseHelper.success(res, "Cancellation policy created successfully", result);
}

/*
 * Get Cancellation Policy by ID
 */
async function getCancellationPolicyByIdController(req, res) {
    const { id } = req.params;
    const result = await cancellationPolicyServiceImport.getCancellationPolicyById(id);
    return ResponseHelper.success(res, "Cancellation policy details", result);
}

/*
 * Get All Cancellation Policies
 */
async function getAllCancellationPoliciesController(req, res) {
    const filters = {
        isActive: req.query.isActive,
        isDefault: req.query.isDefault,
        zoneId: req.query.zoneId ? parseInt(req.query.zoneId) : undefined,
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 10
    };
    const result = await cancellationPolicyServiceImport.getAllCancellationPolicies(filters);
    return ResponseHelper.success(res, "All cancellation policies", result);
}

/*
 * Update Cancellation Policy
 */
async function updateCancellationPolicyController(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await cancellationPolicyServiceImport.updateCancellationPolicy(id, req.body, userId);
    return ResponseHelper.success(res, "Cancellation policy updated successfully", result);
}

/*
 * Delete Cancellation Policy
 */
async function deleteCancellationPolicyController(req, res) {
    const { id } = req.params;
    const result = await cancellationPolicyServiceImport.deleteCancellationPolicy(id);
    return ResponseHelper.success(res, result.message, { policyId: result.policyId });
}

/*
 * Set Default Cancellation Policy
 */
async function setDefaultCancellationPolicyController(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await cancellationPolicyServiceImport.setDefaultCancellationPolicy(id, userId);
    return ResponseHelper.success(res, "Default cancellation policy set successfully", result);
}

/*
 * Toggle Cancellation Policy Status
 */
async function toggleCancellationPolicyStatusController(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await cancellationPolicyServiceImport.toggleCancellationPolicyStatus(id, userId);
    return ResponseHelper.success(res, "Cancellation policy status toggled successfully", result);
}

/*
 * Get Active Cancellation Policy
 */
async function getActiveCancellationPolicyController(req, res) {
    const zoneId = req.query.zoneId ? parseInt(req.query.zoneId) : null;
    const result = await cancellationPolicyServiceImport.getActiveCancellationPolicy(zoneId);
    return ResponseHelper.success(res, "Active cancellation policy", result);
}

/*
 * Get Cancellation Policy Statistics
 */
async function getCancellationPolicyStatisticsController(req, res) {
    const zoneId = req.query.zoneId ? parseInt(req.query.zoneId) : null;
    const result = await cancellationPolicyServiceImport.getCancellationPolicyStatistics(zoneId);
    return ResponseHelper.success(res, "Cancellation policy statistics", result);
}


//!---------------------------------No-Show Policy Management--------------------------------------->>

/*
 * Create No-Show Policy
 */
async function createNoShowPolicyController(req, res) {
    const userId = req.user.id;
    const policyData = {
        ...req.body,
        createdBy: userId
    };
    const result = await noShowPolicyService.createNoShowPolicy(policyData);
    return ResponseHelper.success(res, "No-show policy created successfully", result);
}

/*
 * Get No-Show Policy by ID
 */
async function getNoShowPolicyByIdController(req, res) {
    const { id } = req.params;
    const result = await noShowPolicyService.getNoShowPolicyById(id);
    return ResponseHelper.success(res, "No-show policy details", result);
}

/*
 * Get All No-Show Policies
 */
async function getAllNoShowPoliciesController(req, res) {
    const filters = {
        isActive: req.query.isActive,
        isDefault: req.query.isDefault,
        zoneId: req.query.zoneId ? parseInt(req.query.zoneId) : undefined,
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 10
    };
    const result = await noShowPolicyService.getAllNoShowPolicies(filters);
    return ResponseHelper.success(res, "All no-show policies", result);
}

/*
 * Update No-Show Policy
 */
async function updateNoShowPolicyController(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await noShowPolicyService.updateNoShowPolicy(id, req.body, userId);
    return ResponseHelper.success(res, "No-show policy updated successfully", result);
}

/*
 * Delete No-Show Policy
 */
async function deleteNoShowPolicyController(req, res) {
    const { id } = req.params;
    const result = await noShowPolicyService.deleteNoShowPolicy(id);
    return ResponseHelper.success(res, result.message, { policyId: result.policyId });
}

/*
 * Set Default No-Show Policy
 */
async function setDefaultNoShowPolicyController(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await noShowPolicyService.setDefaultNoShowPolicy(id, userId);
    return ResponseHelper.success(res, "Default no-show policy set successfully", result);
}

/*
 * Toggle No-Show Policy Status
 */
async function toggleNoShowPolicyStatusController(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await noShowPolicyService.toggleNoShowPolicyStatus(id, userId);
    return ResponseHelper.success(res, "No-show policy status toggled successfully", result);
}

/*
 * Get Active No-Show Policy
 */
async function getActiveNoShowPolicyController(req, res) {
    const zoneId = req.query.zoneId ? parseInt(req.query.zoneId) : null;
    const result = await noShowPolicyService.getActiveNoShowPolicy(zoneId);
    return ResponseHelper.success(res, "Active no-show policy", result);
}

/*
 * Get No-Show Policy Statistics
 */
async function getNoShowPolicyStatisticsController(req, res) {
    const zoneId = req.query.zoneId ? parseInt(req.query.zoneId) : null;
    const result = await noShowPolicyService.getNoShowPolicyStatistics(zoneId);
    return ResponseHelper.success(res, "No-show policy statistics", result);
}


//!---------------------------------Reschedule Policy Management--------------------------------------->>

/*
 * Create Reschedule Policy
 */
async function createReschedulePolicyController(req, res) {
    const userId = req.user.id;
    const policyData = {
        ...req.body,
        createdBy: userId
    };
    const result = await reschedulePolicyService.createReschedulePolicy(policyData);
    return ResponseHelper.success(res, "Reschedule policy created successfully", result);
}

/*
 * Get Reschedule Policy by ID
 */
async function getReschedulePolicyByIdController(req, res) {
    const { id } = req.params;
    const result = await reschedulePolicyService.getReschedulePolicyById(id);
    return ResponseHelper.success(res, "Reschedule policy details", result);
}

/*
 * Get All Reschedule Policies
 */
async function getAllReschedulePoliciesController(req, res) {
    const filters = {
        isActive: req.query.isActive,
        isDefault: req.query.isDefault,
        zoneId: req.query.zoneId ? parseInt(req.query.zoneId) : undefined,
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 10
    };
    const result = await reschedulePolicyService.getAllReschedulePolicies(filters);
    return ResponseHelper.success(res, "All reschedule policies", result);
}

/*
 * Update Reschedule Policy
 */
async function updateReschedulePolicyController(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await reschedulePolicyService.updateReschedulePolicy(id, req.body, userId);
    return ResponseHelper.success(res, "Reschedule policy updated successfully", result);
}

/*
 * Delete Reschedule Policy
 */
async function deleteReschedulePolicyController(req, res) {
    const { id } = req.params;
    const result = await reschedulePolicyService.deleteReschedulePolicy(id);
    return ResponseHelper.success(res, result.message, { policyId: result.policyId });
}

/*
 * Set Default Reschedule Policy
 */
async function setDefaultReschedulePolicyController(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await reschedulePolicyService.setDefaultReschedulePolicy(id, userId);
    return ResponseHelper.success(res, "Default reschedule policy set successfully", result);
}

/*
 * Toggle Reschedule Policy Status
 */
async function toggleReschedulePolicyStatusController(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await reschedulePolicyService.toggleReschedulePolicyStatus(id, userId);
    return ResponseHelper.success(res, "Reschedule policy status toggled successfully", result);
}

/*
 * Get Active Reschedule Policy
 */
async function getActiveReschedulePolicyController(req, res) {
    const zoneId = req.query.zoneId ? parseInt(req.query.zoneId) : null;
    const result = await reschedulePolicyService.getActiveReschedulePolicy(zoneId);
    return ResponseHelper.success(res, "Active reschedule policy", result);
}

/*
 * Get Reschedule Policy Statistics
 */
async function getReschedulePolicyStatisticsController(req, res) {
    const zoneId = req.query.zoneId ? parseInt(req.query.zoneId) : null;
    const result = await reschedulePolicyService.getReschedulePolicyStatistics(zoneId);
    return ResponseHelper.success(res, "Reschedule policy statistics", result);
}

/*
 * Get All Active Policies (cancellation, reschedule, no-show) in one call
 */
async function getActivePoliciesController(req, res) {
    const zoneId = req.query.zoneId ? parseInt(req.query.zoneId) : null;
    const result = await activePoliciesService.getActivePolicies(zoneId);
    return ResponseHelper.success(res, "Active policies", result);
}


//!----------------------------------------------------Add Countries,Cities,Zones && Zone Details--------------------------------------->>
/* 
 *  Add Countries
*/
async function addCountries(req, res) {
    const { name, shortName } = req.body;

    // Validate required fields
    if (!name || !shortName) {
        throw new ValidationError('Name and shortName are required fields');
    }

    let flagImg = null;
    if (req.file) {
        let tempImage = req.file.path;
        flagImg = tempImage.replace(/\\/g, "/");
    }

    const data = { ...req.body };
    // Keep shortName as it's required by the database model
    if (flagImg) {
        data.image = flagImg;
    }

    const result = await locationManagementService.addCountry(data);
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
    const data = { ...req.body };
    const result = await locationManagementService.addCity(data);
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
 * Update Country
*/
async function updateCountry(req, res) {
    const { countryId } = req.params;
    const { name, shortName, status } = req.body;

    // Validate required field
    if (!countryId) {
        throw new ValidationError('Country ID is required');
    }

    let flagImg = null;
    if (req.file) {
        let tempImage = req.file.path;
        flagImg = tempImage.replace(/\\/g, "/");
    }

    const data = { ...req.body };
    // Keep shortName as it's required by the database model
    if (flagImg) {
        data.image = flagImg;
    }

    const result = await locationManagementService.updateCountry(countryId, data);
    return ResponseHelper.success(res, "Country Updated Successfully", result);
}

/*
 * Update City
*/
async function updateCity(req, res) {
    const { cityId } = req.params;
    const { name, lat, lng, countryId, status } = req.body;

    // Validate required field
    if (!cityId) {
        throw new ValidationError('City ID is required');
    }

    const data = { ...req.body };
    const result = await locationManagementService.updateCity(cityId, data);
    return ResponseHelper.success(res, "City Updated Successfully", result);
}

/*
 * Delete Country (Soft Delete)
*/
async function deleteCountry(req, res) {
    const { countryId } = req.params;

    // Validate required field
    if (!countryId) {
        throw new ValidationError('Country ID is required');
    }

    const result = await locationManagementService.deleteCountry(countryId);
    return ResponseHelper.success(res, "Country Deleted Successfully", result);
}

/*
 * Delete City (Soft Delete)
*/
async function deleteCity(req, res) {
    const { cityId } = req.params;

    // Validate required field
    if (!cityId) {
        throw new ValidationError('City ID is required');
    }

    const result = await locationManagementService.deleteCity(cityId);
    return ResponseHelper.success(res, "City Deleted Successfully", result);
}


/*
   * Add Zones
*/

async function addZones(req, res) {
    const { name, coordinates, cityId, zoneMinimumAmount, currencyUnitId, distanceUnitId, serviceCharge, zoneAdminComission } = req.body;

    const data = { ...req.body };

    if (data.coordinates) {
        data.coordinates = {
            type: 'Polygon',
            coordinates: data.coordinates
        };
    }

    if (!data.zoneAdminComission) {
        data.zoneAdminComission = 20;
    }

    if(!data.status){
        data.status=true
    }

    const zoneCreate = await zoneManagementService.addZone(data);
    return ResponseHelper.success(res, "Zone Added Successfully", zoneCreate);
}


/*
 * Add Zones by Postcodes
*/
async function addZonesByPostcodes(req, res) {
    console.log('=== Controller: addZonesByPostcodes ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Content-Type:', req.headers['content-type']);
    
    const zoneCreate = await postcodeZoneService.addZoneByPostcodes(req.body);
    return ResponseHelper.success(res, "Zone Added Successfully Using Postcodes", zoneCreate);
}

/*
 * Edit Zone by Postcodes (update zone; optionally send new postcodes to regenerate polygon)
 */
async function editZoneByPostcodes(req, res) {
    const { zoneId } = req.params;
    const updatedZone = await postcodeZoneService.editZoneByPostcodes(zoneId, req.body);
    return ResponseHelper.success(res, "Zone updated successfully", updatedZone);
}

/*
 * Validate if entered postcode is a valid London postcode
 */
async function validateLondonPostcode(req, res) {
    const { postcode } = req.body;
    const result = await postcodeZoneService.validateLondonPostcode(postcode);
    return ResponseHelper.success(res, "Postcode validation result", result);
}


/*
   * Get Zones
*/

async function getZones(req, res) {
    const shapedZones = await zoneManagementService.getZones();
    return ResponseHelper.success(res, "All Zones Fetched Successfully", shapedZones);
}

/*
 * Get Zone By ID
*/
async function getZoneById(req, res) {
    const { zoneId } = req.params;

    const columns = req.query.columns
        ? req.query.columns.split(',').map(column => column.trim()).filter(Boolean)
        : [];

    const zoneData = await zoneManagementService.getZoneById(zoneId, columns);
    return ResponseHelper.success(res, "Zone fetched successfully", zoneData);
}


/*
 * Update Zone
*/

async function updateZone(req, res) {
    const { zoneId } = req.params;

    const data = { ...req.body };

    // If postcodes are being updated, run duplicate check before saving
    if (data.postcodes !== undefined && data.postcodes !== null) {
        let postcodesArray = data.postcodes;
        if (typeof postcodesArray === 'string') {
            try { postcodesArray = JSON.parse(postcodesArray); } catch (e) {
                postcodesArray = postcodesArray.split(',').map(p => p.trim()).filter(Boolean);
            }
        }
        if (Array.isArray(postcodesArray) && postcodesArray.length > 0) {
            await postcodeZoneService.checkDuplicatePostcodes(postcodesArray, parseInt(zoneId));
        }
    }

    if (data.coordinates) {
        data.coordinates = {
            type: 'Polygon',
            coordinates: data.coordinates
        };
    }

    if (data.zoneAdminComission === undefined || data.zoneAdminComission === null) {
        data.zoneAdminComission = 20;
    }

    const updateZone = await zoneManagementService.updateZone(zoneId, data);
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
        const { type } = req.query;
        const getUnits = await dataService.getUnitsDistanceAndCurrency(type);
        const message = type ? `Units of type '${type}' fetched successfully` : "All Units Fetched";
        return ResponseHelper.success(res, message, getUnits);
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

    const data = { ...req.body };
    if (serviceImg) {
        data.image = serviceImg;
    }

    const serviceCreate = await serviceManagementService.addService(data);
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
async function editServices(req, res) {
    const { serviceId } = req.params;
    const { name, description, deleteImage } = req.body;

    let serviceImg = null;

    if (req.file) {
        let tempImage = req.file.path;
        serviceImg = tempImage.replace(/\\/g, "/");
    }

    const data = { ...req.body };
    
    // If deleteImage flag is true, explicitly set image to null
    if (deleteImage === 'true' || deleteImage === true) {
        data.image = null;
    } else if (serviceImg) {
        data.image = serviceImg;
    }

    const editService = await serviceManagementService.editService(serviceId, data);
    return ResponseHelper.success(res, "Service Edited Successfully", editService);
}


/*
  * Update Services Sort Order
*/
async function updateServicesSortOrder(req, res) {
    const { services } = req.body;
    const result = await serviceManagementService.updateServicesSortOrder(services);
    return ResponseHelper.success(res, "Services Sort Order Updated Successfully", result);
}


/*
  * Add Categories
*/
async function AddCategories(req, res) {
    const { name, description } = req.body;

    let CategoryImg = null;

    if (req.file) {
        let tempImage = req.file.path;
        CategoryImg = tempImage.replace(/\\/g, "/");
    }

    const data = { ...req.body };
    if (CategoryImg) {
        data.image = CategoryImg;
    }

    const category = await serviceManagementService.addCategory(data);
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
    const data = { ...req.body };
    const editCategory = await serviceManagementService.editCategories(categoryId, data);
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
  * Unassign Service From Categories
*/
async function unassignServiceFromCategories(req, res) {
    const { serviceId } = req.params;
    const { categoryIds } = req.body; // Optional: array of category IDs to unassign
    
    const result = await serviceManagementService.unassignServiceFromCategories(serviceId, categoryIds);
    return ResponseHelper.success(res, "Service unassigned from categories successfully", result);
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
    const data = { ...req.body };
    const editSubCategory = await serviceManagementService.editSubcategories(subCategoryId, data);
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
    
    const data = { ...req.body };
    
    if (data.weightCapacity) {
        data.weightCapacity = convertToBaseUnits(data.weightCapacity, units.conversionRate.weight);
    }
    if (data.volumeCapacity) {
        data.volumeCapacity = convertToBaseUnits(data.volumeCapacity, units.conversionRate.length);
    }
    if (imagePath) {
        data.image = imagePath;
    }
    
    const result = await vehicleManagementService.addVehicle(data);
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


//!--------------------------------------------Reason Management-----------------------------------------------//
/*
  * Create Reason(s) - Supports single reason or array of reasons
  * Single: { "cancelReason": "reason text" }
  * Array: { "cancelReasons": ["reason1", "reason2", "reason3"] }
*/
async function createReason(req, res) {
    const result = await reasonService.createReason(req.body);
    
    // Handle array response (bulk create)
    if (result.created && Array.isArray(result.created)) {
        return ResponseHelper.success(res, result.message, result);
    }
    
    // Handle single reason response
    return ResponseHelper.success(res, "Reason Added Successfully", result);
}

/*
  * Get All Reasons
*/
async function getAllReasons(req, res) {
    const reasons = await reasonService.getAllReasons();
    return ResponseHelper.success(res, "Reasons Retrieved Successfully", reasons);
}

/*
  * Get Reason By ID
*/
async function getReasonById(req, res) {
    const { reasonId } = req.params;
    const reason = await reasonService.getReasonById(reasonId);
    return ResponseHelper.success(res, "Reason Retrieved Successfully", reason);
}

/*
  * Update Reason
*/
async function updateReason(req, res) {
    const { reasonId } = req.params;
    const updatedReason = await reasonService.updateReason(reasonId, req.body);
    return ResponseHelper.success(res, "Reason Updated Successfully", updatedReason);
}

/*
  * Delete Reason
*/
async function deleteReason(req, res) {
    const { reasonId } = req.params;
    await reasonService.deleteReason(reasonId);
    return ResponseHelper.success(res, "Reason Deleted Successfully", null);
}

//!--------------------------------------------Add-On Services Management-----------------------------------------------//
async function createAddOnService(req, res) {
    const created = await addOnServicesService.createAddOnService(req.body);
    return ResponseHelper.success(res, "Add-on service created successfully", created);
}

async function getAllAddOnServices(req, res) {
    const rows = await addOnServicesService.getAllAddOnServices();
    return ResponseHelper.success(res, "Add-on services retrieved successfully", rows);
}

async function getAddOnServiceById(req, res) {
    const { addOnServiceId } = req.params;
    const row = await addOnServicesService.getAddOnServiceById(addOnServiceId);
    return ResponseHelper.success(res, "Add-on service retrieved successfully", row);
}

async function updateAddOnService(req, res) {
    const { addOnServiceId } = req.params;
    const updated = await addOnServicesService.updateAddOnService(addOnServiceId, req.body);
    return ResponseHelper.success(res, "Add-on service updated successfully", updated);
}

async function deleteAddOnService(req, res) {
    const { addOnServiceId } = req.params;
    await addOnServicesService.deleteAddOnService(addOnServiceId);
    return ResponseHelper.success(res, "Add-on service deleted successfully", null);
}


//!-----------------------------Add Match Preferences-------------------------//
/*
  * Add Preference Types
*/
async function createPreferenceType(req, res) {
    const { name, parentPreferenceTypeId } = req.body

    const findPreferenceType = await preferenceTypes.findOne({
        where: {
            name: name,
            status: true
        }
    })

    if (findPreferenceType) {
        throw new customError('Preference Type Already Exists')
    }

    // If parentPreferenceTypeId provided, verify it exists
    if (parentPreferenceTypeId) {
        const parentExists = await preferenceTypes.findOne({
            where: { id: parentPreferenceTypeId, status: true }
        });
        if (!parentExists) {
            throw new customError('Parent Preference Type Not Found');
        }
    }

    const createPreferenceType = await preferenceTypes.create({
        name,
        status: true,
        parentPreferenceTypeId: parentPreferenceTypeId || null
    })

    return ResponseHelper.success(res, "Preference Type Added", { createPreferenceType });

}

/*
 * Edit Preference Type
*/
async function editPreferenceType(req, res) {
    const { preferenceTypeId } = req.params;
    const { name, parentPreferenceTypeId } = req.body;
    const editPreferenceType = await prefrencesServices.editPreferenceType(preferenceTypeId, name, parentPreferenceTypeId);
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
    const result = await prefrencesServices.unAssignServiceFromPreferences(serviceId);
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
    const optionsFound = await orderService.getOnHoldBookings();
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

//!----------------------------------Support Contact Config-----------------------------------------//

async function getSupportContact(req, res) {
    const data = await supportContactService.getSupportContact();
    return ResponseHelper.success(res, 'Support contact retrieved successfully', data);
}

async function updateSupportContact(req, res) {
    const data = await supportContactService.updateSupportContact(req.body);
    return ResponseHelper.success(res, 'Support contact updated successfully', data);
}

//!----------------------------------FAQ Management-----------------------------------------//

/**
 * Create new FAQ
 */
async function createFAQ(req, res) {
    try {
        const faq = await faqService.createFAQ(req.body);
        return ResponseHelper.success(res, faq, "FAQ created successfully", 201);
    } catch (error) {
        return ResponseHelper.error(res, error);
    }
}

/**
 * Get all FAQs
 */
async function getAllFAQs(req, res) {
    try {
        const { status } = req.query;
        const filters = status !== undefined ? { status: status === 'true' } : {};
        const faqs = await faqService.getAllFAQs(filters);
        return ResponseHelper.success(res, faqs, "FAQs retrieved successfully");
    } catch (error) {
        return ResponseHelper.error(res, error);
    }
}

/**
 * Get FAQ by ID
 */
async function getFAQById(req, res) {
    try {
        const { faqId } = req.params;
        const faq = await faqService.getFAQById(faqId);
        return ResponseHelper.success(res, faq, "FAQ retrieved successfully");
    } catch (error) {
        return ResponseHelper.error(res, error);
    }
}

/**
 * Update FAQ
 */
async function updateFAQ(req, res) {
    try {
        const { faqId } = req.params;
        const faq = await faqService.updateFAQ(faqId, req.body);
        return ResponseHelper.success(res, faq, "FAQ updated successfully");
    } catch (error) {
        return ResponseHelper.error(res, error);
    }
}

/**
 * Delete FAQ
 */
async function deleteFAQ(req, res) {
    try {
        const { faqId } = req.params;
        const result = await faqService.deleteFAQ(faqId);
        return ResponseHelper.success(res, result, "FAQ deleted successfully");
    } catch (error) {
        return ResponseHelper.error(res, error);
    }
}

/**
 * Toggle FAQ status
 */
async function toggleFAQStatus(req, res) {
    try {
        const { faqId } = req.params;
        const faq = await faqService.toggleFAQStatus(faqId);
        return ResponseHelper.success(res, faq, "FAQ status toggled successfully");
    } catch (error) {
        return ResponseHelper.error(res, error);
    }
}

//!----------------------------------Blog Management-----------------------------------------//

/**
 * Create new Blog
 */
async function createBlog(req, res) {
    try {
        // Handle single image
        let imagePath = null;
        if (req.files && req.files.image && req.files.image[0]) {
            imagePath = `Public/BlogImages/${req.files.image[0].filename}`;
        } else if (req.file) {
            // Fallback for single file upload
            imagePath = `Public/BlogImages/${req.file.filename}`;
        }

        // Handle multiple description images
        let descriptionImages = [];
        if (req.files && req.files.descriptionImages && Array.isArray(req.files.descriptionImages)) {
            descriptionImages = req.files.descriptionImages.map(file => `Public/BlogImages/${file.filename}`);
        }

        const blogData = {
            ...req.body,
            image: imagePath,
            descriptionImages: descriptionImages
        };
        const blog = await blogService.createBlog(blogData);
        return ResponseHelper.success(res, blog, "Blog created successfully", 201);
    } catch (error) {
        return ResponseHelper.error(res, error);
    }
}

/**
 * Get all Blogs
 */
async function getAllBlogs(req, res) {
    try {
        const { status } = req.query;
        const filters = status !== undefined ? { status: status === 'true' } : {};
        const blogs = await blogService.getAllBlogs(filters);
        return ResponseHelper.success(res, blogs, "Blogs retrieved successfully");
    } catch (error) {
        return ResponseHelper.error(res, error);
    }
}

/**
 * Get Blog by ID
 */
async function getBlogById(req, res) {
    try {
        const { blogId } = req.params;
        const blog = await blogService.getBlogById(blogId);
        return ResponseHelper.success(res, blog, "Blog retrieved successfully");
    } catch (error) {
        return ResponseHelper.error(res, error);
    }
}

/**
 * Update Blog
 */
async function updateBlog(req, res) {
    try {
        const { blogId } = req.params;
        
        // Handle single image
        let imagePath = undefined;
        if (req.files && req.files.image && req.files.image[0]) {
            imagePath = `Public/BlogImages/${req.files.image[0].filename}`;
        } else if (req.file) {
            // Fallback for single file upload
            imagePath = `Public/BlogImages/${req.file.filename}`;
        }

        // Handle multiple description images
        let descriptionImages = undefined;
        if (req.files && req.files.descriptionImages && Array.isArray(req.files.descriptionImages)) {
            descriptionImages = req.files.descriptionImages.map(file => `Public/BlogImages/${file.filename}`);
        }

        const blogData = {
            ...req.body,
            image: imagePath,
            descriptionImages: descriptionImages
        };
        const blog = await blogService.updateBlog(blogId, blogData);
        return ResponseHelper.success(res, blog, "Blog updated successfully");
    } catch (error) {
        return ResponseHelper.error(res, error);
    }
}

/**
 * Delete Blog
 */
async function deleteBlog(req, res) {
    try {
        const { blogId } = req.params;
        const result = await blogService.deleteBlog(blogId);
        return ResponseHelper.success(res, result, "Blog deleted successfully");
    } catch (error) {
        return ResponseHelper.error(res, error);
    }
}

/**
 * Toggle Blog status
 */
async function toggleBlogStatus(req, res) {
    try {
        const { blogId } = req.params;
        const blog = await blogService.toggleBlogStatus(blogId);
        return ResponseHelper.success(res, blog, "Blog status toggled successfully");
    } catch (error) {
        return ResponseHelper.error(res, error);
    }
}


//!-------------Order Status----------------//
async function getAllOrderStatuses(req, res) {
    const result = await customerOrderService.allOrderStatus();
    return ResponseHelper.success(res, result.message, result.data);
}

//!-------------------Exports----------------//
module.exports = {
    //!-------------Admin Dashboard--------//
    adminDashboard,
    //-------------Vehicles--------//
    addVehicle,
    //!-------------Countries,Cities--------//
    addCountries,
    getCountries,
    updateCountry,
    deleteCountry,
    addCities,
    getCities,
    getCitiesByCountryId,
    updateCity,
    deleteCity,
    getCountries,
    //!-------------Add Zones--------//
    addZones,
    addZonesByPostcodes,
    editZoneByPostcodes,
    validateLondonPostcode,
    getZones,
    getZoneById,
    deleteZone,
    updateZone,
    //!-------------Units--------//
    getUnitsDistanceAndCurrency,
    //!-------------Categories,SubCategories--------//
    AddCategories,
    addSubCategories,
    getCategories,
    getSubcategories,
    serviceCategoriesAssign,
    unassignServiceFromCategories,
    editSubCategories,
    editCategories,
    deleteCategories,
    deleteSubCategories,
    //!-------------Services--------//
    getAllServices,
    AddServices,
    deleteServices,
    editServices,
    updateServicesSortOrder,
    //!-------------Units--------//
    getUnitsDistanceAndCurrency,
    getAllUnits,
    //!-------------Cancel Booking--------//
    cancelBooking,
    getCancelBookingReasons,
    //!-------------Laundry Roles--------//
    laundryRoles,
    //!-------------Machinery--------//
    addMachines,
    //!-------------Reason Management--------//
    createReason,
    getAllReasons,
    getReasonById,
    updateReason,
    deleteReason,
    //!------------Add-On Services-----------//
    createAddOnService,
    getAllAddOnServices,
    getAddOnServiceById,
    updateAddOnService,
    deleteAddOnService,
    //!------------Account Preferences-----------//
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
    //!--------on Hold Option------------//
    onHoldOptions,
    customerOnHoldOptions,
    getOnHoldCustomerOptions,
    getOnHoldOptions,
    getOnHoldBookings,
    //!------------Customer Management-------//
    getAllCustomers,
    customerCount,
    specificCustomerDetails,
    updateCustomer,
    deleteCustomer,
    //!-----------Driver Management----------//
    countTotalDrivers,
    allDriverMiniDetails,
    driverStatusChange,
    specificdriverDetail,
    updateDriver,
    deleteDriver,
    addDriverByLaundryShop,
    //!----------Order Management------------//
    ordersCount,
    allOrderDetails,
    pendingOrders,
    allCancelOrders,
    completeOrders,
    editOrder,
    getOrderForEdit,
    getServiceDetailWithBookingSelection,
    deleteOrder,
    updateInvoice,
    //!----------Service Management---------//
    getAdminServicesWithCategories,
    addServiceTypes,
    getSubCategories,
    addServiceItems,
    getServicesAndCategoriesForOrderEdit,
    //!----------Employee Management---------//
    getAdminEmployess,
    addEmployee,
    updateEmployee,
    changeEmployeeStatus,
    getAdminEmployeeDetail,
    updateAdminEmployee,
    deleteAdminEmployee,
    addAgentEmployee,
    updateAgentEmployee,
    changeAgentEmployeeStatus,
    getAllAgentEmployees,
    deleteAgentEmployee,
    //!----------Agent Registration Management---------//
    registerAgent,
    addAgentBusinessInfo,
    addAgentServices,
    updateAgentWorkingHours,
    getAgentCompleteInfo,
    addAgentAddress,
    editAgentAddress,
    getAgentAddress,
    getShopAddress,
    //!----------Add,Roles,Permissions && Features ---------//
    addRole,
    updateRoles,
    getAllRoles,
    addClassifiedAs,
    getClassifiedAs,
    addfeatures,
    getFeatures,
    deleteFeature,
    //!------------Shop Management-----------//
    getShopInformation,
    shopsData,
    singleShopData,
    deleteShop,
    getShopEmployees,
    getAllEmployeesWithShopInfo,
    //!------------Cancellation Policy Management-----------//
    createCancellationPolicyController,
    getCancellationPolicyByIdController,
    getAllCancellationPoliciesController,
    updateCancellationPolicyController,
    deleteCancellationPolicyController,
    setDefaultCancellationPolicyController,
    toggleCancellationPolicyStatusController,
    getActiveCancellationPolicyController,
    getCancellationPolicyStatisticsController,
    //!-------------No-Show Policy--------//
    createNoShowPolicyController,
    getNoShowPolicyByIdController,
    getAllNoShowPoliciesController,
    updateNoShowPolicyController,
    deleteNoShowPolicyController,
    setDefaultNoShowPolicyController,
    toggleNoShowPolicyStatusController,
    getActiveNoShowPolicyController,
    getNoShowPolicyStatisticsController,
    //!-------------Reschedule Policy Management--------//
    createReschedulePolicyController,
    getReschedulePolicyByIdController,
    getAllReschedulePoliciesController,
    updateReschedulePolicyController,
    deleteReschedulePolicyController,
    setDefaultReschedulePolicyController,
    toggleReschedulePolicyStatusController,
    getActiveReschedulePolicyController,
    getReschedulePolicyStatisticsController,
    getActivePoliciesController,
    //!-------------Support contact config--------//
    getSupportContact,
    updateSupportContact,
    //!-------------FAQ Management--------//
    createFAQ,
    getAllFAQs,
    getFAQById,
    updateFAQ,
    deleteFAQ,
    toggleFAQStatus,
    //!-------------Blog Management--------//
    createBlog,
    getAllBlogs,
    getBlogById,
    updateBlog,
    deleteBlog,
    toggleBlogStatus,
    //!-------------Order Status----------------//
    getAllOrderStatuses
}
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
const AdminResponseHelper = require('../../utils/adminResponseHelper');
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
    employeeManagementService
} = require('../../services/Admin');

//!----------------------------------Admin Dashboard-----------------------------------------//
async function adminDashboard(req, res) {
    try {
        const outObj = await dashboardService.getDashboardData();
        //return res.json(responsefunc("1", "Admin Dashboard Data", outObj, ""));
        return AdminResponseHelper.success(res, "Admin Dashboard Data", outObj);
    } catch (error) {
        console.error("Dashboard Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}







//!----------------------------------Customer Management-----------------------------------------//

/*
  * Get All Customers
*/
async function getAllCustomers(req, res) {
    try {
        const formattedCustomers = await customerService.getAllCustomers();
        return AdminResponseHelper.success(res, "All Customer Details", formattedCustomers);
    } catch (error) {
        console.error("Get All Customers Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}

/*
   * Customers Count
*/
async function customerCount(req, res) {
    try {
        const outObj = await customerService.getCustomerCount();
        return AdminResponseHelper.success(res, "All Customer Count", outObj);
    } catch (error) {
        console.error("Customer Count Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}



/*
  * Specific Customer Details
*/
async function specificCustomerDetails(req, res) {
    try {
        const { customerId } = req.params;
        const output = await customerService.getSpecificCustomerDetails(customerId);
        return AdminResponseHelper.success(res, "Customer Order Details", output);
    } catch (error) {
        console.error("Specific Customer Details Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}


/*
  * Update Customer Details
*/
async function updateCustomer(req, res) {
    const { customerId } = req.params;
    const { firstName, lastName, email, phoneNum, status } = req.body;

    // Validation
    if (!customerId || isNaN(customerId)) {
        throw new ValidationError('Invalid customer ID provided');
    }

    // Check if customer exists
    const customerExists = await users.findOne({
        where: {
            id: customerId,
            userTypeId: 2 // Ensure it's a customer
        }
    });

    if (!customerExists) {
        throw new NotFoundError('Customer not found');
    }

    // Check if email is being changed and if it already exists
    if (email && email !== customerExists.email) {
        const emailExists = await users.findOne({
            where: {
                email: email,
                id: { [Op.ne]: customerId },
                userTypeId: 2
            }
        });

        if (emailExists) {
            throw new ConflictError('Email already exists');
        }
    }

    // Update customer details
    const updateData = {};
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (email) updateData.email = email;
    if (phoneNum) updateData.phoneNum = phoneNum;
    if (status !== undefined) updateData.status = status;

    const updatedCustomer = await users.update(updateData, {
        where: {
            id: customerId,
            userTypeId: 2
        }
    });

    if (updatedCustomer[0] === 0) {
        throw new ValidationError('No changes were made');
    }

    // Get updated customer data
    const updatedCustomerData = await users.findOne({
        where: {
            id: customerId,
            userTypeId: 2
        },
        attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'status', 'createdAt']
    });

    return AdminResponseHelper.success(res, "Customer updated successfully", updatedCustomerData);
}


/*
  * Delete Customer
*/
async function deleteCustomer(req, res) {
    const { customerId } = req.params;

    // Check if customer exists
    const customerExists = await users.findOne({
        where: {
            id: customerId,
            userTypeId: 2 // Ensure it's a customer
        }
    });

    if (!customerExists) {
        throw new customError("Customer not found", "Please provide a valid customer ID");
    }

    // Check if customer has any active bookings
    const activeBookings = await booking.count({
        where: {
            customerId: customerId,
            bookingStatusId: {
                [Op.notIn]: [17, 19, 23] // Exclude completed, cancelled, and failed bookings
            }
        }
    });

    if (activeBookings > 0) {
        throw new customError("Cannot delete customer", `Customer has ${activeBookings} active booking(s). Please complete or cancel all bookings first.`);
    }

    // Soft delete the customer (set status to false instead of hard delete)
    const deletedCustomer = await users.update(
        { status: false },
        {
            where: {
                id: customerId,
                userTypeId: 2
            }
        }
    );

    if (deletedCustomer[0] === 0) {
        throw new customError("Failed to delete customer", "No changes were made");
    }

    return AdminResponseHelper.success(res, "Customer deleted successfully", { customerId });
}


//!----------------------------------------------------Drivers Management--------------------------------------->>
/* 
 *  Drivers Count
*/
async function countTotalDrivers(req, res) {
    try {
        const outObj = await driverService.getDriverCount();
        return AdminResponseHelper.success(res, "All Counts Fetched", outObj);
    } catch (error) {
        console.error("Driver Count Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}


/* 
 *  All Drivers Detail 
*/
async function allDriverMiniDetails(req, res) {
    try {
        const driversWithBookingCounts = await driverService.getAllDriversWithStats();
        return AdminResponseHelper.success(res, "Drivers Details fetched", driversWithBookingCounts);
    } catch (error) {
        console.error("All Drivers Details Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}


/* 
 *  All Drivers Detail 
*/
async function driverStatusChange(req, res) {
    const { driverId } = req.params

    const driverStatusChange = await users.update({
        status: false
    }, {
        where: {
            id: driverId
        }
    })

    return AdminResponseHelper.success(res, "Driver Status Updated", driverStatusChange);

}



/* 
 *   Specific Driver Detail  
*/
async function specificdriverDetail(req, res) {
    const { driverId } = req.params

    const userInfo = await driverInZones.findOne({
        where: {
            driverId: driverId,
        },
        include: [
            {
                model: users,
                as: 'driverInZone',
                attributes: ['id', 'firstName', 'lastName', 'email'],
                include: [
                    {
                        model: roles,
                        attributes: ['name']
                    }
                ]
            },
            {
                model: bussinessInformation,
                as: 'laundaryDriver',
                attributes: ['shopName', 'shopAddressId'],
                include: [{
                    model: addressDb,
                    attributes: ['streetAddress', 'province', 'district', 'addressType']
                }]
            },
        ],
        attributes: ['laundaryShopId']
    })

    // Check if driver exists in driverInZones table
    if (!userInfo) {
        throw new customError("Driver not found", "Driver does not exist in the system");
    }

    const findBooking = await booking.findAll({
        where: {
            driverId: driverId,
            [Op.or]: [
                { driverId: driverId },
                { deliveryDriverId: driverId }
            ]
        },
        include: [
            {
                model: proofOfDeliveries,
                attributes: ['id', 'imgUpload', 'noOfItems', 'bookingId', 'userId']
            },
            {
                model: addressDb,
                as: 'pickupAddress',
                attributes: ['title', 'streetAddress', 'district', 'province', 'addressType']
            },
            {
                model: addressDb,
                as: 'dropOffAddress',
                attributes: ['title', 'streetAddress', 'district', 'province', 'addressType']
            }
        ],
        attributes: {
            exclude: ['createdAt', 'updatedAt', 'onHoldReason', 'categoryId', 'serviceId', 'subCategoryId', 'vehicleTypeId', 'OnHoldOtherReasons']
        }
    })

    const driverTotalOrders = await booking.count({
        where: {
            driverId: driverId,
            [Op.or]: [
                { driverId: driverId },
                { deliveryDriverId: driverId }
            ]
        }
    })

    const pendingOrder = await booking.count({
        where: {
            bookingStatusId: {
                [Op.ne]: 11
            },
            [Op.or]: [
                { driverId: driverId },
                { deliveryDriverId: driverId }
            ]

        }
    })

    let outObj = {
        userInformation: userInfo,
        driverBookings: findBooking,
        totalOrders: driverTotalOrders,
        pendingOrders: pendingOrder

    }


    return AdminResponseHelper.success(res, `All booking Fetched for Driver id:${driverId}`, outObj);

}

/*
 * Update Driver
*/
async function updateDriver(req, res) {
    const { driverId } = req.params;
    const { firstName, lastName, email, phoneNum, status } = req.body;

    // Check if driver exists
    const driverExists = await users.findOne({
        where: {
            id: driverId,
            roleId: 6, // Ensure it's a driver
            classifiedAsId: 1
        }
    });

    if (!driverExists) {
        throw new customError("Driver not found", "Please provide a valid driver ID");
    }

    // Check if email is being changed and if it already exists
    if (email && email !== driverExists.email) {
        const emailExists = await users.findOne({
            where: {
                email: email,
                id: { [Op.ne]: driverId },
                roleId: 6,
                classifiedAsId: 1
            }
        });

        if (emailExists) {
            throw new customError("Email already exists", "Please use a different email address");
        }
    }

    // Update driver details
    const updateData = {};
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (email) updateData.email = email;
    if (phoneNum) updateData.phoneNum = phoneNum;
    if (status !== undefined) updateData.status = status;

    const updatedDriver = await users.update(updateData, {
        where: {
            id: driverId,
            roleId: 6,
            classifiedAsId: 1
        }
    });

    if (updatedDriver[0] === 0) {
        throw new customError("Failed to update driver", "No changes were made");
    }

    // Get updated driver data
    const updatedDriverData = await users.findOne({
        where: {
            id: driverId,
            roleId: 6,
            classifiedAsId: 1
        },
        attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'status', 'createdAt'],
        include: [
            {
                model: roles,
                attributes: ['name']
            }
        ]
    });

    return AdminResponseHelper.success(res, "Driver updated successfully", updatedDriverData);
}

//!----------------------------------------------------Orders Management-------------------------------------------------------------->>

/* 
 *  All Orders Counts
*/
async function ordersCount(req, res) {
    try {
        const outObj = await orderService.getOrderCount();
        return AdminResponseHelper.success(res, "All Order Count", outObj);
    } catch (error) {
        console.error("Orders Count Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}


/*
  * All Order Details - Optimized Version
*/
async function allOrderDetails(req, res) {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const statusFilter = req.query.status;
        const dateFilter = req.query.date;

        const filters = {};
        if (statusFilter) filters.status = statusFilter;
        if (dateFilter) filters.date = dateFilter;

        const outObj = await orderService.getAllOrderDetails(filters, page, limit);
        return AdminResponseHelper.success(res, "All booking Details Fetched", outObj);
    } catch (error) {
        console.error("All Order Details Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}



/*
  * Pending Orders - Optimized Version
*/
async function pendingOrders(req, res) {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const outObj = await orderService.getPendingOrders(page, limit);
        return AdminResponseHelper.success(res, "All Pending Orders", outObj);
    } catch (error) {
        console.error("Pending Orders Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}




/*
  * Cancel Orders - Optimized Version
*/
async function allCancelOrders(req, res) {

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const whereClause = {
            bookingStatusId: {
            [Op.eq]: [19]
            }
    };

    const result = await getOptimizedBookings(whereClause, page, limit);

    let outObj = {
        cancelOrders: result.bookings,
        cancelBookingCount: result.totalCount,
        pagination: result.pagination
    };

    return AdminResponseHelper.success(res, "All Cancel Orders Details", outObj);

}




/*
  * Complete Orders - Optimized Version
*/
async function completeOrders(req, res) {

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const whereClause = {
            bookingStatusId: {
            [Op.eq]: [17]
        }
    };

    const result = await getOptimizedBookings(whereClause, page, limit);

    let outObj = {
        allCompletedOrders: result.bookings,
        completedOrdersCount: result.totalCount,
        pagination: result.pagination
    };

    return AdminResponseHelper.success(res, "All Completed Orders", outObj);

}

/*
  * Edit Order - Comprehensive Order Management
*/
async function editOrder(req, res) {
        const { orderId } = req.params;
        const {
            orderTrackId,
            collectionDate,
            collectionTimeFrom,
            collectionTimeTo,
            deliveryDate,
            deliveryTimeFrom,
            deliveryTimeTo,
            driverInstructionOptions,
            driverInstructionOptions1,
            driverInstruction,
            totalItems,
            orderAmount,
            subTotal,
            frequency,
            bookingStatusId,
            services,
            billingDetails
        } = req.body;

        const orderExists = await booking.findOne({
            where: { id: orderId },
        include: [
            {
                model: customerSelectedService,
                include: [
                        { model: service, attributes: ['id', 'name'] },
                        { model: categories, attributes: ['id', 'name'] }
                    ]
                },
                { model: billingDetails }
            ]
        });

        if (!orderExists) {
            return AdminResponseHelper.notFound(res, "Order not found", "Invalid order ID");
        }

        // Update basic order fields
        const orderUpdateData = {
            orderTrackId, collectionDate, collectionTimeFrom, collectionTimeTo,
            deliveryDate, deliveryTimeFrom, deliveryTimeTo,
            driverInstructionOptions, driverInstructionOptions1, driverInstruction,
            totalItems, orderAmount, subTotal, frequency, bookingStatusId
        };

        await booking.update(orderUpdateData, { where: { id: orderId } });

        // Update services
        if (Array.isArray(services)) {
            await customerSelectedService.destroy({ where: { bookingId: orderId } });

            const serviceData = services.map(s => ({
                bookingId: orderId,
                serviceId: s.serviceId,
                categoryId: s.categoryId,
                date: s.date || new Date(),
                time: s.time || new Date().toTimeString().slice(0, 8),
                items: s.items || 1,
                servicePrice: s.servicePrice || 0,
                categoryPrice: s.categoryPrice || 0,
                status: s.status !== undefined ? s.status : true
            }));

            await customerSelectedService.bulkCreate(serviceData);
        }

        // Update billing details
        if (billingDetails) {
            const billingUpdateData = {
                upfrontAmount: billingDetails.upfrontAmount,
                discount: billingDetails.discount,
                total: billingDetails.total,
                zoneAdminCommission: billingDetails.zoneAdminCommission,
                serviceCharge: billingDetails.serviceCharge,
                categoryCharge: billingDetails.categoryCharge,
                pickupDriverEarning: billingDetails.pickupDriverEarning,
                deliveryDriverEarning: billingDetails.deliveryDriverEarning,
                paymentStatus: billingDetails.paymentStatus
            };

            const existingBilling = await billingDetails.findOne({ where: { bookingId: orderId } });

            if (existingBilling) {
                await billingDetails.update(billingUpdateData, { where: { bookingId: orderId } });
            } else {
                await billingDetails.create({ bookingId: orderId, ...billingUpdateData });
            }
        }

        // Fetch updated order
        const updatedOrder = await booking.findOne({
            where: { id: orderId },
            include: [
                {
                    model: customerSelectedService,
                    include: [
                        { model: service, attributes: ['id', 'name'] },
                        { model: categories, attributes: ['id', 'name'] }
                    ]
                },
                { model: billingDetails },
                { model: bookingStatus, attributes: ['id', 'title', 'description'] },
                { model: addressDb, as: 'pickupAddress', attributes: ['id', 'title', 'streetAddress', 'district', 'province'] },
                { model: addressDb, as: 'dropOffAddress', attributes: ['id', 'title', 'streetAddress', 'district', 'province'] }
            ]
        });

        return AdminResponseHelper.success(res, "Order updated successfully", updatedOrder);
    
}

/*
  * Get Single Order Details for Editing
*/
async function getOrderForEdit(req, res) {
        const { orderId } = req.params;

        const orderDetails = await booking.findOne({
            where: { id: orderId },
        include: [
            {
                model: customerSelectedService,
                include: [
                        { model: service, attributes: ['id', 'name'] },
                        { model: categories, attributes: ['id', 'name'] }
                    ]
                },
                {
                    model: billingDetails
                },
                {
                    model: bookingStatus,
                    attributes: ['id', 'title', 'description']
                },
                {
                    model: addressDb,
                    as: 'pickupAddress',
                    attributes: ['id', 'title', 'streetAddress', 'district', 'province']
            },
            {
                model: addressDb,
                    as: 'dropOffAddress',
                    attributes: ['id', 'title', 'streetAddress', 'district', 'province']
                },
                {
                    model: users,
                    as: 'customer',
                    attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum']
                },
                {
                    model: users,
                    as: 'driver',
                    attributes: ['id', 'firstName', 'lastName', 'email']
                },
                {
                    model: users,
                    as: 'deliveryDriver',
                    attributes: ['id', 'firstName', 'lastName', 'email']
                }
            ]
        });

        if (!orderDetails) {
            throw new customError("Order not found", "Please provide a valid order ID");
        }

        return AdminResponseHelper.success(res, "Order details fetched successfully", orderDetails);

}


//!---------------------------------Service Management--------------------------------------->>

/*
  * Get Admin Service Types
*/
async function getAdminServicesWithCategories(req, res) {
    try {
        const outObj = await serviceManagementService.getAdminServicesWithCategories();
        return AdminResponseHelper.success(res, "All Services with Count Fetched", outObj);
    } catch (error) {
        console.error("Admin Services with Categories Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
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

    return AdminResponseHelper.success(res, "Service Type Added Successfully", category);


}



/*
  * Get SubCategories/Items
*/

async function getSubCategories(req, res) {
    try {
        const { categoryId } = req.params;
        const outObj = await serviceManagementService.getSubCategories(categoryId);
        return AdminResponseHelper.success(res, "All Items fetched", outObj);
    } catch (error) {
        console.error("Get SubCategories Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}

/*
  * Get All Services and Categories for Order Edit
*/
async function getServicesAndCategoriesForOrderEdit(req, res) {

       
    const services = await service.findAll({
        where: { status: true },
        attributes: ['id', 'name', 'description']
    });

  
    const categoriesData = await categories.findAll({
        where: { status: true },
        attributes: ['id', 'name', 'description'],
        include: [
            {
                model: subCategories,
                attributes: ['id', 'name', 'price'],
                where: { status: true }
            }
        ]
    });

 
    const serviceCategoriesData = await serviceCategories.findAll({
        where: { status: true },
        include: [
            {
                model: service,
                attributes: ['id', 'name']
            },
            {
                model: categories,
                attributes: ['id', 'name']
            }
        ]
    });

    const outObj = {
        services: services,
        categories: categoriesData,
        serviceCategories: serviceCategoriesData
    };

    return AdminResponseHelper.success(res, "Services and Categories fetched successfully", outObj);
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

    return AdminResponseHelper.success(res, "SubCategory Added Successfully", createSubCategory);
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


    return AdminResponseHelper.success(res, "Admin Employees", outObj);

}

/* 
 *  Add Admin Employee
*/
async function addEmployee(req, res) {
    const { firstName, lastName, email, password, phoneNum, roleId, zoneId } = req.body

    const adminId = req.user.id


    const userFind = await users.findOne({
        where: {
            classifiedAsId: 2,
            roleId: roleId
        }
    })

    if (userFind) {
        throw new customError("Employee Already Exists")
    }

    let hashpassword = await bcrypt.hash(password, 10)

    const user = await users.create({
        firstName,
        lastName,
        email,
        password: hashpassword,
        phoneNum,
        roleId,
        status: true,
        classifiedAsId: 2,
        roleId: roleId,
        verifiedAt: Date.now()
    })

    if (user.roleId === 7) {
        await users.update({
            employeeOff: adminId
        }, { where: { id: adminId } })

        await zone.update({
            zoneAdminId: user.id
        }, { where: { id: zoneId } })
    }


    if (user.roleId === 6) {
        await users.update({
            employeeOff: adminId
        }, { where: { id: adminId } })
    }

    return AdminResponseHelper.success(res, "Employee Added Successfully", user);

}


/*
  * Update Employee
*/
async function updateEmployee(req, res) {
    const { firstName, lastName, email, phoneNum, roleId, updatePassword, employeeId } = req.body

    const userExists = await users.findOne({
        where: {
            email: email ? email : null,
            id: { [Op.not]: employeeId },
            classifiedAs: 2
        }
    })

    if (userExists) {
        throw new customError("Employee with the following email exists",
            "Please try another email"
        )
    }

    if (updatePassword) {
        let hashpassword = await bcrypt.hash(updatePassword, 10)
        users.update({
            firstName,
            lastName,
            email,
            password: hashpassword,
            phoneNum,
            roleId
        }, { where: { id: employeeId } })
    } else {
        users.update({
            firstName,
            lastName,
            email,
            roleId
        }, { where: { id: employeeId } })
    }


    return AdminResponseHelper.success(res, "Employee Updated Successfully", {});
}


/*
    * Change Employee status
*/
async function changeEmployeeStatus(req, res) {
    const { status, employeeId } = req.body

    users.update({
        status
    }, {
        where: {
            id: employeeId
        }
    })

    return AdminResponseHelper.success(res, "Employee Status Updated", {});

}
//!------------------------Admin Create Roles,Classicifations,Permissions-------------------------//

/*
   * Add Roles
*/

async function addRole(req, res) {
    const { name, permissionRole } = req.body;

    const checkExist = await roles.findOne({ where: { name } });
    if (checkExist) {
        throw new customError("Same role exists", "Please try another name");
    }
    const newRole = await roles.create({ name, status: true });
    let bulkArray = [];
    permissionRole.map((ele) => {
        if (ele.permissions.create === true) {
            bulkArray.push({
                permissionType: "create",
                featureId: ele.id,
                roleId: newRole.id,
            });
        }
        if (ele.permissions.read === true) {
            bulkArray.push({
                permissionType: "read",
                featureId: ele.id,
                roleId: newRole.id,
            });
        }
        if (ele.permissions.update === true) {
            bulkArray.push({
                permissionType: "update",
                featureId: ele.id,
                roleId: newRole.id,
            });
        }
        if (ele.permissions.delete === true) {
            bulkArray.push({
                permissionType: "delete",
                featureId: ele.id,
                roleId: newRole.id,
            });
        }
    });
    await permissions.bulkCreate(bulkArray);

    return AdminResponseHelper.success(res, "Role and Permission Added Successfully", {});

}


/*
   * Update Roles
*/
async function updateRoles(req, res) {

    const { name, permissionRole, roleId } = req.body;

    // Check if the role name already exists
    const checkExist = await roles.findOne({
        where: { name, id: { [Op.not]: roleId } },
    });

    if (checkExist) {
        throw new customError("Same role exists", "Please try another name");
    }


    await roles.update({ name, status: true }, { where: { id: roleId } });

    await permissions.destroy({ where: { roleId } });


    const bulkArray = permissionRole.flatMap((ele) => {
        const permissions = [];
        if (ele.permissions.create) {
            permissions.push({ permissionType: "create", featureId: ele.id, roleId });
        }
        if (ele.permissions.read) {
            permissions.push({ permissionType: "read", featureId: ele.id, roleId });
        }
        if (ele.permissions.update) {
            permissions.push({ permissionType: "update", featureId: ele.id, roleId });
        }
        if (ele.permissions.delete) {
            permissions.push({ permissionType: "delete", featureId: ele.id, roleId });
        }
        return permissions;
    });

    // Bulk insert new permissions
    await permissions.bulkCreate(bulkArray);

    return AdminResponseHelper.success(res, "Role updated", {});

}


/*
  * Get All Roles
*/
async function getAllRoles(req, res) {


    const getRoles = await roles.findAll({
        where: {
            status: true
        },
        attributes: ['id', 'name', 'status']
    })

    return AdminResponseHelper.success(res, "Get All Roles", getRoles);

}

/*
   * Add Classified
*/
async function addClassifiedAs(req, res) {
    const { name } = req.body
    const createData = await classifiedAs.create({
        name
    })
    return AdminResponseHelper.success(res, "Added the classified As", createData);

}


/*
   * Get ClassifiedAs
*/
async function getClassifiedAs(req, res) {

    const findData = await classifiedAs.findAll({
        attributes: ['id', 'name']
    })

    return AdminResponseHelper.success(res, "Fetched All ClassifiedAs Roles", findData);

}



/*
   * Add Features
*/
async function addfeatures(req, res) {
    const { title, status, featureOf, key } = req.body

    const titleFound = await features.findOne({
        where: {
            title: title,
            key: key
        }
    })

    if (titleFound) {
        throw new customError("Feature Alreay Exists")

    }

    const createFeatures = await features.create({
        title,
        status,
        featureOf,
        key
    })
    return AdminResponseHelper.success(res, "Feature Added", createFeatures);

}


/*
   * Get Features
*/
async function getFeatures(req, res) {


    const findFeature = await features.findAll({
        where: {
            status: true
        },
        attributes: ['id', 'name', 'status']
    })

    return AdminResponseHelper.success(res, "All Features Fetched", findFeature);

}


//!------------------------------------------------------------Shop Management------------------------------------------------->>>>>>>

/*
   * Shop Counts
*/
async function getShopInformation(req, res) {
    try {
        const outObj = await shopManagementService.getShopInformation();
        return AdminResponseHelper.success(res, "Shops Information Fetched", outObj);
    } catch (error) {
        console.error("Shop Information Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}


/*
   * All Shops Data
*/
async function shopsData(req, res) {
    try {
        const outObj = await shopManagementService.getShopsData();
        return AdminResponseHelper.success(res, "Shop Information Data", outObj);
    } catch (error) {
        console.error("Shops Data Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}

/*
   * Single Shops Data
*/
async function singleShopData(req, res) {
    try {
        const { Id } = req.params;
        const shopData = await shopManagementService.getSingleShopData(Id);
        return AdminResponseHelper.success(res, "Single Shop Data", shopData);
    } catch (error) {
        console.error("Single Shop Data Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}


/*
   * Get Shop Employees
*/
async function getShopEmployees(req, res) {
    try {
        const { bussinessId } = req.params;
        const findEmployees = await shopManagementService.getShopEmployees(bussinessId);
        return AdminResponseHelper.success(res, "Employee Data Fetched", findEmployees);
    } catch (error) {
        console.error("Get Shop Employees Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}


//!----------------------------------------------------Add Countries,Cities,Zones && Zone Details--------------------------------------->>
/* 
 *  Add Countries
*/
async function addCountries(req, res) {
    const { name, shortName } = req.body

    let flagImg = null;

    if (req.file) {
        let tempImage = req.file.path;
        flagImg = tempImage.replace(/\\/g, "/")
    }

    const countryCreate = await countries.create({
        name,
        shortName,
        image: flagImg,
        status: true
    })

    return AdminResponseHelper.success(res, "Country Added Successfully", countryCreate);

}

/*
   * Get Countries
*/
async function getCountries(req, res) {
    try {
        const getCountry =await dataService.getCountries();
        return AdminResponseHelper.success(res, "All Countries fetched", getCountry);
    } catch (error) {
        console.error("Get Countries Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}


/*
   * Add Cities
*/

async function addCities(req, res) {
    const { name, lat, lng, countryId } = req.body

    const addCity = await cities.create({
        name,
        lat,
        lng,
        status: true,
        countryId
    })

    return AdminResponseHelper.success(res, "City Added Successfully", addCity);

}

/*
   * Get Cities
*/
async function getCities(req, res) {
    try {
        const getCities =await dataService.getCities();
        return AdminResponseHelper.success(res, "All Cities Fetched", getCities);
    } catch (error) {
        console.error("Get Cities Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}


/*
   * Add Zones
*/

async function addZones(req, res) {
    const { name, coordinates, cityId, zoneMinimumAmount, currencyUnitId, distanceUnitId, serviceCharge, zoneAdminComission } = req.body

    const polygon = {
        type: 'Polygon',
        coordinates: coordinates
    }

    const zoneCreate = await zone.create({
        name,
        coordinates: polygon,
        status: true,
        cityId,
        zoneMinimumAmount,
        currencyUnitId,
        distanceUnitId,
        serviceCharge,
        zoneAdminComission: zoneAdminComission ? zoneAdminComission : 20
    })

    return AdminResponseHelper.success(res, "Zone Added Successfully", zoneCreate);

}


/*
   * Get Zones
*/

async function getZones(req, res) {
    try {
        const shapedZones = await dataService.getZones();
        return AdminResponseHelper.success(res, "All Zones Fetched Successfully", shapedZones);
    } catch (error) {
        console.error("Get Zones Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}


/*
 * Update Zone
*/

async function updateZone(req, res) {
    const { name, coordinates, cityId, zoneMinimumAmount, currencyUnitId, distanceUnitId, serviceCharge, zoneAdminComission } = req.body
    const { zoneId } = req.params;

    const zoneToUpdate = await zone.findOne({
        where: { id: zoneId }
    })

    if (!zoneToUpdate) {
        return AdminResponseHelper.notFound(res, "Zone not found");
    }

    const polygon = {
        type: 'Polygon',
        coordinates: coordinates
    }

    const updateZone = await zone.update({
        name,
        coordinates: polygon,
        cityId,
        zoneMinimumAmount,
        currencyUnitId,
        distanceUnitId,
        serviceCharge,
        zoneAdminComission: zoneAdminComission ? zoneAdminComission : 20
    }, { where: { id: zoneId } })

    return AdminResponseHelper.success(res, "Zone Updated Successfully", updateZone);


}







/*
 * Delete Zone
*/
async function deleteZone(req, res) {
    const { zoneId } = req.query;

    if (!zoneId) {
        return AdminResponseHelper.validationError(res, "zoneId is required");
    }

    const zoneToDelete = await zone.destroy({ where: { id: zoneId } });

    if (!zoneToDelete) {
        return AdminResponseHelper.notFound(res, "Zone not found");
    }


    return AdminResponseHelper.success(res, "Zone deleted successfully (soft delete)", {});;
}


//!-----------------------Units Management--------------------//
async function getUnitsDistanceAndCurrency(req, res) {
    try {
        const getUnits = await dataService.getUnitsDistanceAndCurrency();
        return AdminResponseHelper.success(res, "All Units Fetched", getUnits);
    } catch (error) {
        console.error("Get Units Distance And Currency Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}
async function getAllUnits(req, res) {
    try {
        const getUnits = await dataService.getAllUnits();
        return AdminResponseHelper.success(res, "All Units Fetched", getUnits);
    } catch (error) {
        console.error("Get All Units Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}
//!-----------------------Add Services,Categories and SubCategories --------------------//
/*

*  Add Services

*/
async function AddServices(req, res) {
    try {
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

        return AdminResponseHelper.success(res, "Services Added Successfully", serviceCreate);
    } catch (error) {
        console.error("Add Services Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}


/*
*  Get All Services
*/
async function getAllServices(req, res) {
    try {
        const result = await serviceManagementService.getAllServices();
        console.log("🚀 ~ getAllServices ~ result:", result)
        return AdminResponseHelper.success(res, "All Services", result);
    } catch (error) {
        console.error("Get All Services Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}


/*
  * Delete Services
*/
async function deleteServices(req, res) {
    const { serviceId } = req.params;
    const deleteService = await serviceManagementService.deleteService(serviceId);
    return AdminResponseHelper.success(res, "Service Deleted Successfully", deleteService);
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
    return AdminResponseHelper.success(res, "Service Edited Successfully", editService);
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

    return AdminResponseHelper.success(res, "Category Added Successfully", category);

}




/*
  * Get All Categories
*/
async function getCategories(req, res) {
    try {
        const getCategories = await serviceManagementService.getCategories();
        return AdminResponseHelper.success(res, "All Categories Fetched", getCategories);
    } catch (error) {
        console.error("Get Categories Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}

/*
  * Edit Categories
*/
async function editCategories(req, res) {
    const { categoryId } = req.params;
    const { name, description } = req.body;
    const editCategory = await serviceManagementService.editCategories(categoryId, name, description);
    return AdminResponseHelper.success(res, "Category Edited Successfully", editCategory);
}

/*
  * Delete Categories
*/
async function deleteCategories(req, res) {
    const { categoryId } = req.params;
    const deleteCategory = await serviceManagementService.deleteCategories(categoryId);
    return AdminResponseHelper.success(res, "Category Deleted Successfully", deleteCategory);
}


/*
  * Assign Services to Categories
*/
async function serviceCategoriesAssign(req, res) {
    const { serviceId, categoryId } = req.body;

    if (!serviceId || !categoryId || !Array.isArray(categoryId) || categoryId.length === 0) {
        throw new customError("Invalid input. Please provide serviceId and an array of categoryIds.");
    }


    const existingAssignments = await serviceCategories.findAll({
        where: {
            serviceId,
            categoryId: { [Op.in]: categoryId },
            status: true
        },
        attributes: ['categoryId']
    });

    const existingCategoryIds = existingAssignments.map(item => item.categoryId);


    const newCategoryIds = categoryId.filter(id => !existingCategoryIds.includes(id));

    if (newCategoryIds.length === 0) {
        return AdminResponseHelper.validationError(res, "All selected categories are already assigned to the service.");
    }


    const serviceCategoriesData = newCategoryIds.map(id => ({
        serviceId: serviceId,
        categoryId: id,
        status: true
    }));


    const createData = await serviceCategories.bulkCreate(serviceCategoriesData);

    return AdminResponseHelper.success(res, "Service assigned to categories successfully.", { createData });
}






/*
  * Add SubCategories
*/
async function addSubCategories(req, res) {
    const categoryData = req.body
    console.log("🚀 ~ addSubCategories ~ req.body:", req.body)

    const processedData = categoryData.map((cat) => {
        const fileName = `barcode-${Date.now()}-${Math.floor(Math.random() * 10000)}.png`;
        const barcodePath = generateBarcodeforSubCategories(cat.name, cat.price, fileName)

        return {
            ...cat,
            status: true,
            barCode: barcodePath
        }

    })
    console.log("🚀 ~ processedData ~ processedData:", processedData)

    const createSubCategories = await subCategories.bulkCreate(processedData);

    if (!createSubCategories) {
        throw new customError("There is error in the request")
    }

    return AdminResponseHelper.success(res, "SubCategories Added Successfully", createSubCategories);

}


/*
  * Get SubCategories
*/
async function getSubcategories(req, res) {
    try {
        const getSubcategories = await serviceManagementService.getSubcategories();
        return AdminResponseHelper.success(res, "All SubCategories Fetched", getSubcategories);
    } catch (error) {
        console.error("Get Subcategories Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}

/*
  * Edit SubCategories
*/

async function editSubCategories(req, res) {
    const { subCategoryId } = req.params;
    const { name, price } = req.body;
    const editSubCategory = await serviceManagementService.editSubcategories(subCategoryId, name, price);
    return AdminResponseHelper.success(res, "SubCategory Edited Successfully", editSubCategory);
}


//!-----------------------------------Driver && Vechicles------------------------------------------->>
/* 
 *  Add vehicle
*/

async function addVehicle(req, res) {
    let { title, baseRate, perUnitRate, weightCapacity, volumeCapacity } =
        req.body;
    const appUnitId = await currentAppUnitsId();
    const units = await unitsSymbolsAndRates(appUnitId);
    weightCapacity = convertToBaseUnits(
        weightCapacity,
        units.conversionRate.weight
    );
    volumeCapacity = convertToBaseUnits(
        volumeCapacity,
        units.conversionRate.length
    );
    const vehicleExist = await vehicleType.findOne({
        where: { title, status: true },
    });
    if (vehicleExist)
        throw new CustomException(
            "A vehicle with the same name already exists",
            " Please try some other name"
        );
    // check on image
    let imagePath = "";
    if (req.file) {
        let tmpPath = req.file.path;
        imagePath = tmpPath.replace(/\\/g, "/");
        // getting units
    } else {
        imagePath = ""; // throw new CustomException('Image not uploaded', 'Please upload image');
    }
    const created = await vehicleType.create({
        title,
        status: true,
        image: imagePath,
        baseRate,
        perUnitRate,
        weightCapacity,
        volumeCapacity,
    });
    return AdminResponseHelper.success(res, "Vehicle added", created);
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
    return AdminResponseHelper.success(res, "Reason Added", reasonCreate);

}


/*
  *  Get All Cancel Booking Reasons
*/

async function getCancelBookingReasons(req, res) {
    try {
        const getBooking = dataService.getCancelBookingReasons();
        return AdminResponseHelper.success(res, "All Cancel Booking reasons fetched", getBooking);
    } catch (error) {
        console.error("Get Cancel Booking Reasons Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}

//!------------------------Admin Create Roles,Classicifations,Permissions-------------------------//
async function laundryRoles(req, res) {
    const { name, status } = req.body
    const roleCreation = await roles.create({
        name,
        status
    })

    return AdminResponseHelper.success(res, "Roles Added Successfully", roleCreation);

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
    return AdminResponseHelper.success(res, "Machine Added", createMachine);

}



//!-----------------------------Add Match Preferences-------------------------//
/*
  * Add Preferences
*/
async function AddServicePreferences(req, res) {
    const { title } = req.body

    const findPref = await preferencesServiceName.findOne({
        where: {
            title: title,
            status: true
        }
    })

    if (findPref) {
        throw new customError('Title Already Exists')
    }

    const createPreferences = await preferencesServiceName.create({
        title,
        status: true
    })

    return AdminResponseHelper.success(res, "Service Preferences Added Successfully", createPreferences);
}

/*
  * Get Account Preferences
*/
async function getAccountPreferences(req, res) {
    try {
        const preFind = dataService.getAccountPreferences();
        return AdminResponseHelper.success(res, "All Account Preferences Fetched", preFind);
    } catch (error) {
        console.error("Get Account Preferences Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
}

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

    return AdminResponseHelper.success(res, "Preference Type Added", { createPreferenceType });

}

/*
 * Edit Preference Type
*/
async function editPreferenceType(req, res) {
    const { preferenceTypeId } = req.params;
    const { name } = req.body;
    const editPreferenceType = await prefrencesServices.editPreferenceType(preferenceTypeId, name);
    return AdminResponseHelper.success(res, "Preference Type Edited", editPreferenceType);
}

/*
 * Delete Preference Type
*/
async function deletePreferenceTypeController(req, res) {
    const { preferenceTypeId } = req.params;
    const deletePreferenceType = await prefrencesServices.deletePreferenceType(preferenceTypeId);
    return AdminResponseHelper.success(res, "Preference Type Deleted", deletePreferenceType);
}

/*
  * Add Preference Values
*/
async function addPreferenceValues(req, res) {
    const { value, preferenceTypeId } = req.body;

    if (!preferenceTypeId || !value || (Array.isArray(value) && value.length === 0)) {
        return AdminResponseHelper.validationError(res, "Value(s) and preferenceTypeId are required");
    }

    const valuesToInsert = Array.isArray(value) ? value : [value];

    const existingValues = await preferenceValues.findAll({
        where: {
            value: valuesToInsert,
            preferenceTypeId: preferenceTypeId,
            status: true
        }
    });

    const existingValueSet = new Set(existingValues.map(v => v.value));

    const newValues = valuesToInsert.filter(v => !existingValueSet.has(v));

    if (newValues.length === 0) {
        return AdminResponseHelper.validationError(res, "All preference values already exist");
    }

    const bulkData = newValues.map(v => ({
        value: v,
        preferenceTypeId,
        status: true
    }));

    const createdValues = await preferenceValues.bulkCreate(bulkData);

    return res.json(
        responsefunc(
            "1",
            `${createdValues.length} Preference Value(s) Added`,
            { createdValues },
            ""
        )
    );
}

/*
 * Edit Preference Values
*/
async function editPreferenceValuesController(req, res) {
    const { preferenceValueId } = req.params;
    const { value } = req.body;
    const editPreferenceValuesData = await prefrencesServices.editPreferenceValues(preferenceValueId, value);
    return AdminResponseHelper.success(res, "Preference Values Edited", editPreferenceValuesData);
}


/*
 * Delete Preference Values
*/
async function deletePreferenceValuesController(req, res) {
    const { preferenceValueId } = req.params;
    const deletePreferenceValuesData = await prefrencesServices.deletePreferenceValues(preferenceValueId);
    return AdminResponseHelper.success(res, "Preference Values Deleted", deletePreferenceValuesData);
}

/*
  * Add Service With Preferences
*/
async function addServiceWithPreferences(req, res) {
    const { serviceId, preferenceTypeId } = req.body;

    if (!preferenceTypeId || !serviceId || (Array.isArray(serviceId) && serviceId.length === 0)) {
        return AdminResponseHelper.validationError(res, "preferenceTypeId and serviceId(s) are required");
    }

    const serviceIds = Array.isArray(serviceId) ? serviceId : [serviceId];

    const existingMappings = await serviceWithPreferences.findAll({
        where: {
            preferenceTypeId,
            serviceId: serviceIds,
            status: true
        }
    });

    const existingServiceIds = new Set(existingMappings.map(m => m.serviceId));

    const newMappings = serviceIds
        .filter(id => !existingServiceIds.has(id))
        .map(id => ({
            serviceId: id,
            preferenceTypeId,
            status: true
        }));

    if (newMappings.length === 0) {
        return AdminResponseHelper.validationError(res, "All Services already mapped to this Preference");
    }

    const createdMappings = await serviceWithPreferences.bulkCreate(newMappings);

    return res.json(
        responsefunc(
            "1",
            `${createdMappings.length} Service(s) mapped to Preference`,
            { createdMappings },
            ""
        )
    );
}


/*
  * Get Preference Types
*/
async function getPreferenceTypes(req, res) {
        const getPreferenceTypes = await dataService.getPreferenceTypes();
        return AdminResponseHelper.success(res, "All Preference Types Fetched", getPreferenceTypes);
    
}


/*
  * Get Preferences And Services Data
*/
async function servicesAndPreferencesData(req,res) {
    const {serviceId}=req.params
    const getData=await serviceManagementService.getAllPreferenceTypesAndServiceDetails(serviceId)
    return AdminResponseHelper.success(res,"All Preferences and Services Data Fetched",getData)
    
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

    return AdminResponseHelper.success(res, "on Hold Options Created", optionsCreate);


}


/*
  * Get On Hold Options
*/

async function getOnHoldOptions(req, res) {
    try {
        const getOptions = await dataService.getOnHoldOptions();
        return AdminResponseHelper.success(res, "All on Hold Options Fetched", getOptions);
    } catch (error) {
        console.error("Get On Hold Options Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
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


    return AdminResponseHelper.success(res, "Customer Hold Option", optionsCreate);
}


/*
  * Get On Hold Customer Options
*/
async function getOnHoldCustomerOptions(req, res) {
    try {
        const optionsFound = dataService.getOnHoldCustomerOptions();
        return AdminResponseHelper.success(res, "All Options Fetched", optionsFound);
    } catch (error) {
        console.error("Get On Hold Customer Options Error:", error);
        return AdminResponseHelper.error(res, "Something went wrong", error.message);
    }
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
    //--------on Hold Option------------//
    onHoldOptions,
    customerOnHoldOptions,
    getOnHoldCustomerOptions,
    getOnHoldOptions,
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
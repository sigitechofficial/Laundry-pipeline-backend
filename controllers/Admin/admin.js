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
const customError = require('../../middlewares/customError')
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

//!----------------------------------Admin Dashboard-----------------------------------------//
async function adminDashboard(req, res) {
    try {
        const revenue = await billingDetails.sum("zoneAdminCommission", {
            where: {
                zoneAdminCommission: {
                    [Op.ne]: null,
                },
            },
        });

        const totalBookings = await booking.count();
        const totalUsers = await users.count();

        const totalCustomer = await users.count({
            where: {
                userTypeId: 2,
                status: true,
            },
        });

        const totalAgent = await users.count({
            where: {
                userTypeId: 4,
            },
        });

        const totalAgentActive = await users.count({
            where: {
                userTypeId: 4,
                status: true,
            },
        });


        const completedBookings = await booking.findAll({
            where: {
                bookingStatusId: 17,
            },
            include: [
                {
                    model: bookingHistory,
                    where: {
                        bookingStatusId: 17,
                    },
                    required: true,
                },
            ],
        });

        let totalCompletionTime = 0;
        let completedCount = 0;

        for (const bookingItem of completedBookings) {
            const creationHistory = await bookingHistory.findOne({
                where: {
                    bookingId: bookingItem.id,
                    bookingStatusId: 1,
                },
            });

            const completionHistory = await bookingHistory.findOne({
                where: {
                    bookingId: bookingItem.id,
                    bookingStatusId: 17,
                },
            });

            if (creationHistory && completionHistory) {
                const creationDateTime = new Date(`${creationHistory.date} ${creationHistory.time}`);
                const completionDateTime = new Date(`${completionHistory.date} ${completionHistory.time}`);

                const timeDiff = completionDateTime - creationDateTime;
                totalCompletionTime += timeDiff;
                completedCount++;
            }
        }

        const averageCompletionTimeHours =
            completedCount > 0 ? totalCompletionTime / completedCount / (1000 * 60 * 60) : 0;

        const acceptedByAgents = await booking.count({
            where: {
                driverId: {
                    [Op.ne]: null,
                },
            },
        });

        //return res.json(acceptedByAgents)

        const assignedToAgents = await booking.count({
            where: {
                deliveryDriverId: {
                    [Op.ne]: null,
                },
            },
        });


        const agentAcceptanceRate =
            assignedToAgents > 0
                ? Math.round((acceptedByAgents / assignedToAgents) * 100) / 100
                : 0;

        // Final response object
        const outObj = {
            adminRevenue: revenue,
            totalBookings: totalBookings,
            totalUsers: totalUsers,
            totalCustomers: totalCustomer,
            totalAgents: totalAgent,
            totalAgentActive: totalAgentActive,
            averageOrderCompletionTimeHours: Math.round(averageCompletionTimeHours * 100) / 100,
            completedOrdersCount: completedCount,
            agentAcceptanceRate: agentAcceptanceRate,
        };

        return res.json(responsefunc("1", "Admin Dashboard Data", outObj, ""));
    } catch (error) {
        console.error("Dashboard Error:", error);
        return res.status(500).json(responsefunc("0", "Something went wrong", {}, error.message));
    }
}







//!----------------------------------Customer Management-----------------------------------------//

/*
  * Get All Customers
*/
async function getAllCustomers(req, res) {
    const findCustomers = await users.findAll({
        where: {
            userTypeId: 2,  // Ensuring we're fetching only customers
        },
        attributes: [
            'id',
            'firstName',
            'lastName',
            'email',
            'phoneNum',
            'status',
            [
                sequelize.literal(`(
            SELECT COUNT(*) 
            FROM bookings 
            WHERE bookings.customerId = users.id
          )`),
                'bookingCount'
            ],
            [
                sequelize.literal(`(
            SELECT COALESCE(SUM(orderAmount), 0) 
            FROM bookings 
            WHERE bookings.customerId = users.id
          )`),
                'totalAmountSpent'
            ],
            [
                sequelize.literal(`(
            SELECT MAX(createdAt) 
            FROM bookings 
            WHERE bookings.customerId = users.id
          )`),
                'lastBookingDate'
            ]
        ]
    });

    // Format the last booking date and totalAmountSpent
    const formattedCustomers = findCustomers.map(customer => {
        const customerData = customer.toJSON(); // Convert to plain object
        return {
            ...customerData,
            lastBookingDate: customerData.lastBookingDate
                ? new Date(customerData.lastBookingDate).toISOString().split('T')[0]
                : null,
            totalAmountSpent: customerData.totalAmountSpent.toFixed(2) // Limit to 2 decimals
        };
    });

    return res.json(responsefunc("1", "All Customer Details", formattedCustomers, ""));
}

/*
   * Customers Count
*/
async function customerCount(req, res) {

    const customerCount = await users.count({
        where: {
            userTypeId: 2
        }
    }
    )
    console.log("🚀 ~ customerCount ~ customerCount:", customerCount)


    const fourDayAgo = new Date();
    console.log("🚀 ~ customerCount ~ fouDayAgo:", fourDayAgo)
    fourDayAgo.setDate(fourDayAgo.getDate() - 4)


    const recentCustomer = await users.count({
        where: {
            userTypeId: 2,
            createdAt: {
                [Op.gte]: fourDayAgo
            }
        }
    })

    const activeUser = await users.count({
        where: {
            status: true,
            userTypeId: 2
        }
    })

    const repeatCustomers = await booking.findAll({
        attributes: [
            'customerId',
            [sequelize.fn('COUNT', sequelize.col('customerId')), 'RepeatingCustomerCount']
        ],
        group: ['customerId'],
        having: sequelize.literal('COUNT(customerId) > 1'),
        order: [[sequelize.fn('COUNT', sequelize.col('customerId')), 'DESC']],
        include: [
            {
                model: users,
                as: 'customer',
                attributes: ['id', 'email', 'firstName', 'lastName']
            }
        ]
    })

    const repeatCustomersCount = repeatCustomers.length


    let outObj = {
        TotalCustomer: customerCount,
        NewCustomers: recentCustomer,
        activeUser: activeUser,
        RepeatedCustomers: repeatCustomersCount

    }

    return res.json(responsefunc("1", "All Customer Count", outObj, ""))
}



/*
  * Specific Customer Details
*/

async function specificCustomerDetails(req, res) {
    const { customerId } = req.params;
    const [bookingsFind, userInfo] = await Promise.all([
        booking.findAll({
            where: { customerId },
            include: [
                {
                    model: customerSelectedService,
                    include: [
                        {
                            model: service,
                            attributes: ['name']
                        }
                    ],
                    attributes: ['id', 'date', 'time', 'items', 'serviceId', 'categoryPrice'],
                },
                {
                    model: OnHoldConfirmation,
                    required: false,
                    attributes: ['onHoldImg', 'noOfItems', 'description', 'bookingId'],
                },
                {
                    model: addressDb,
                    as: 'laundryShop',
                    include: {
                        model: bussinessInformation,
                        attributes: ['shopName'],
                    },
                    attributes: ['id'],
                },
                {
                    model: bookingStatus,
                    attributes: ['title', 'description'],
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
            ],
            order: [['id', 'DESC']],
            attributes: {
                exclude: [
                    'updatedAt', 'categoryId', 'serviceId', 'subCategoryId', 'vehicleTypeId',
                    'driverInstructionOptions', 'driverInstructionOptions1', 'paymentConfirmed',
                    'partialPayment', 'subTotal', 'frequency', 'onHoldReason', 'OnHoldOtherReason',
                    'paymentMethodId', 'paymentIntentId', 'pickupAddresId', 'dropOffAddressId', 'tipId'
                ],
            },
        }),


        addressDb.findOne({
            where: { userId: customerId },
            include: [
                {
                    model: users,
                    attributes: ['id', 'firstName', 'lastName', 'email'],
                },
            ],
            order: [['createdAt', 'DESC']],
            attributes: ['id', 'title', 'streetAddress', 'district', 'province', 'lat', 'lng', 'status', 'addressType', 'userId'],
        }),
    ]);


    const bookingIds = bookingsFind.map((booking) => ({
        bookingIDS: booking.id,
    }));


    const output = {
        bookingDetails: bookingsFind,
        userDetails: userInfo ? userInfo.toJSON() : {},
    };

    return res.json(responsefunc("1", "Customer Order Details", output, ""));
}


/*
  * Update Customer Details
*/
async function updateCustomer(req, res) {
    const { customerId } = req.params;
    const { firstName, lastName, email, phoneNum, status } = req.body;

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
            throw new customError("Email already exists", "Please use a different email address");
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
        throw new customError("Failed to update customer", "No changes were made");
    }

    // Get updated customer data
    const updatedCustomerData = await users.findOne({
        where: {
            id: customerId,
            userTypeId: 2
        },
        attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'status', 'createdAt']
    });

    return res.json(responsefunc("1", "Customer updated successfully", updatedCustomerData, ""));
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

    return res.json(responsefunc("1", "Customer deleted successfully", { customerId }, ""));
}


//!----------------------------------------------------Drivers Management--------------------------------------->>
/* 
 *  Drivers Count
*/
async function countTotalDrivers(req, res) {
    const driverCount = await users.count({
        where: {
            roleId: 6,
            classifiedAsId: 1
        }
    })

    const shopAgentDrivers = await users.count({
        where: {
            roleId: 6,
            classifiedAsId: 1
        }
    })

    const availableDrivers = await users.count({
        where: {
            status: true,
            classifiedAsId: 1,
            roleId: 6
        }
    })

    const blockDrivers = await users.count({
        where: {
            status: false,
            classifiedAsId: 1,
            roleId: 6
        }
    })

    let outObj = {
        totalDrivers: driverCount,
        shopAgentDrivers: shopAgentDrivers,
        availableDrivers: availableDrivers,
        blockDrivers: blockDrivers
    }

    return res.json(responsefunc("1", "All Counts Fetched", outObj, ""))
}


/* 
 *  All Drivers Detail 
*/
async function allDriverMiniDetails(req, res) {

    const findDrivers = await users.findAll({
        where: {
            roleId: 6,
            classifiedAsId: 1,
            status: true
        },
        attributes: [
            'id',
            'firstName',
            'lastName',
            'email',
            'userTypeId',
            'classifiedAsId',
            'roleId',
            'status',
            'createdAt'
        ],
        include: [
            {
                model: roles,
                attributes: ['name']
            }
        ]
    });

    // Get booking counts for each driver
    const driversWithBookingCounts = await Promise.all(
        findDrivers.map(async (driver) => {
            const driverId = driver.id;

            // Get pickup orders count
            const pickupOrdersCount = await booking.count({
                where: {
                    driverId: driverId
                }
            });

            // Get delivery orders count
            const deliveryOrdersCount = await booking.count({
                where: {
                    deliveryDriverId: driverId
                }
            });

            // Get total orders count
            const totalOrdersCount = await booking.count({
                where: {
                    [Op.or]: [
                        { driverId: driverId },
                        { deliveryDriverId: driverId }
                    ]
                }
            });

            // Get completed orders count
            const completedOrdersCount = await booking.count({
                where: {
                    [Op.or]: [
                        { driverId: driverId },
                        { deliveryDriverId: driverId }
                    ],
                    bookingStatusId: 17 // Completed status
                }
            });

            // Get pending orders count
            const pendingOrdersCount = await booking.count({
                where: {
                    [Op.or]: [
                        { driverId: driverId },
                        { deliveryDriverId: driverId }
                    ],
                    bookingStatusId: {
                        [Op.notIn]: [17, 19, 23] // Exclude completed, cancelled, and failed
                    }
                }
            });

            // Get driver earnings from completed orders
            const driverEarnings = await booking.sum('orderAmount', {
                where: {
                    [Op.or]: [
                        { driverId: driverId },
                        { deliveryDriverId: driverId }
                    ],
                    bookingStatusId: 17 // Only completed orders
                }
            });

            return {
                ...driver.toJSON(),
                DriverPickUpOrders: pickupOrdersCount,
                DriverDeliveryOrders: deliveryOrdersCount,
                totalOrders: totalOrdersCount,
                completedOrders: completedOrdersCount,
                pendingOrders: pendingOrdersCount,
                driverEarnings: parseFloat((driverEarnings || 0).toFixed(2))
            };
        })
    );

    return res.json(responsefunc("1", "Drivers Details fetched", driversWithBookingCounts, ""));
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

    return res.json(responsefunc("1", "Driver Status Updated", driverStatusChange, ""))

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


    return res.json(responsefunc("1", `All booking Fetched for Driver id:${driverId}`, outObj, ""))

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

    return res.json(responsefunc("1", "Driver updated successfully", updatedDriverData, ""));
}

//!----------------------------------------------------Orders Management-------------------------------------------------------------->>

/* 
 *  All Orders Counts
*/
async function ordersCount(req, res) {


    const allOrderCount = await booking.count()

    const completedOrder = await booking.count({
        where: {
            bookingStatusId: 17
        }
    })

    const onHoldOrders = await booking.count({
        where: {
            bookingStatusId: {
                [Op.or]: [18, 24]
            }
        }
    })
    console.log("🚀 ~ ordersCount ~ onHoldOrders:", onHoldOrders)

    let outObj = {
        allOrderCount: allOrderCount,
        completedOrders: completedOrder,
        onHoldOrders: onHoldOrders

    }

    return res.json(responsefunc("1", "All Order Count", outObj, ""))
}


/*
  * All Order Details - Optimized Version
*/
async function allOrderDetails(req, res) {


    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;


    const statusFilter = req.query.status;
    const dateFilter = req.query.date;


    let whereClause = {};
    if (statusFilter) {
        whereClause.bookingStatusId = statusFilter;
    }
    if (dateFilter) {
        whereClause.createdAt = {
            [Op.gte]: new Date(dateFilter),
            [Op.lt]: new Date(new Date(dateFilter).getTime() + 24 * 60 * 60 * 1000)
        };
    }

    const result = await getOptimizedBookings(whereClause, page, limit);

    let outObj = {
        orderDetails: result.bookings,
        pagination: result.pagination
    };

    return res.json(responsefunc("1", "All booking Details Fetched", outObj, ""));
}



/*
  * Pending Orders - Optimized Version
*/
async function pendingOrders(req, res) {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const whereClause = {
        bookingStatusId: {
            [Op.ne]: [17, 23]
        }
    };

    const result = await getOptimizedBookings(whereClause, page, limit);

    let outObj = {
        orderDetails: result.bookings,
        pendingOrdersCount: result.totalCount,
        pagination: result.pagination
    };

    return res.json(responsefunc("1", "All Pending Orders", outObj, ""));
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

    return res.json(responsefunc("1", "All Cancel Orders Details", outObj, ""));

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

    return res.json(responsefunc("1", "All Completed Orders", outObj, ""));

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
            return res.status(404).json(responsefunc("0", "Order not found", {}, "Invalid order ID"));
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

        return res.json(responsefunc("1", "Order updated successfully", updatedOrder, ""));
    
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

        return res.json(responsefunc("1", "Order details fetched successfully", orderDetails, ""));

}


//!---------------------------------Service Management--------------------------------------->>

/*
  * Get Admin Service Types
*/

async function getAdminServicesWithCategories(req, res) {

    const countAndService = await subCategories.findAll({
        attributes: [
            'id',
            [sequelize.fn('COUNT', sequelize.col('categoryId')), 'categorySubItemCount']
        ],
        include: [
            {
                model: categories,
                attributes: ['id', 'name', 'status', 'image']
            }
        ],
        group: ['categoryId'],
    })

    const outObj = {
        serviceTypes: countAndService
    }

    return res.json(responsefunc("1", "All Services with Count Fetched", outObj, ""))
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

    return res.json(responsefunc("1", "Service Type Added Sucessfully", category))


}



/*
  * Get SubCategories/Items
*/

async function getSubCategories(req, res) {
    const { categoryId } = req.params

    const findData = await subCategories.findAll({
        where: {
            categoryId: categoryId
        },
        attributes: ['id', 'name', 'price', 'status']
    })

    let outObj = {
        serviceTypesItems: findData
    }

    return res.json(responsefunc("1", "All Items fetched", outObj, ""))

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

    return res.json(responsefunc("1", "Services and Categories fetched successfully", outObj, ""));
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

    return res.json(responsefunc("1", "SubCategory", createSubCategory, ""))
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


    return res.json(responsefunc("1", "Admin Employess", outObj, ""))

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

    return res.json(responsefunc("1", "Employee Added Sucessfully", user, ""))

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


    return res.json(responsefunc("1", "Employee Updated Sucesfully", {}, ""))
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

    return res.json(responsefunc("1", "Employee Status Updated", {}, ""))

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

    return res.json(responsefunc("1", "Role and Permission Added Sucesfully", {}, ""))

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

    return res.json(responsefunc("1", "Role updated", {}, ""));

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

    return res.json(responsefunc("1", "Get All Roles", getRoles, " "))

}

/*
   * Add Classified
*/
async function addClassifiedAs(req, res) {
    const { name } = req.body
    const createData = await classifiedAs.create({
        name
    })
    return res.json(responsefunc("1", "Added the classified As", createData, ""))

}


/*
   * Get ClassifiedAs
*/
async function getClassifiedAs(req, res) {

    const findData = await classifiedAs.findAll({
        attributes: ['id', 'name']
    })

    return res.json(responsefunc("1", "Fetched All ClassifiedAs Roles", findData, " "))

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
    return res.json(responsefunc("1", "Feature Added", createFeatures, ""))

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

    return res.json(responsefunc("1", "All Features Fetched", findFeature, " "))

}


//!------------------------------------------------------------Shop Management------------------------------------------------->>>>>>>

/*
   * Shop Counts
*/
async function getShopInformation(req, res) {

    const fourDayAgo = new Date();
    fourDayAgo.setDate(fourDayAgo.getDate() - 4)


    const getShopsCount = await addressDb.count({
        where: {
            addressType: 'LaundaryShopAddress'
        }
    })

    const newRegisterShops = await addressDb.count({
        where: {
            status: true,
            createdAt: {
                [Op.gte]: fourDayAgo
            }
        }
    })

    const activeShops = await addressDb.count({
        where: {
            addressType: 'LaundaryShopAddress',
            status: true
        }
    })

    const inActiveShops = await addressDb.count({
        where: {
            addressType: 'LaundaryShopAddress',
            status: false
        }
    })

    let outObj = {
        getShopsCount: getShopsCount,
        newRegisterShops: newRegisterShops,
        activeShops: activeShops,
        inActiveShops: inActiveShops
    }


    return res.json(responsefunc("1", "Shops Information Fetched", outObj, ""))
}


/*
   * All Shops Data
*/
async function shopsData(req, res) {
    const getShopData = await bussinessInformation.findAll({
        include: [
            {
                model: users,
                as: 'businessInfo',
                attributes: [
                    'firstName',
                    'lastName',
                    'email',
                    'phoneNum',
                    'userTypeId',
                    [
                        sequelize.literal(`(SELECT COUNT(*) FROM users WHERE users.employeeOff = businessInfo.id)`),
                        'TotalEmployees',
                    ]
                ],
                include: [
                    {
                        model: bussinessWorkingHours,
                        where: {
                            status: true
                        },
                        attributes: ['id', 'dayOfWeek', 'openTime', 'closeTime']
                    }
                ]
            },
            {
                model: addressDb,
                attributes: ['streetAddress', 'province', 'district', 'addressType', 'cityId', 'countryId',
                    [
                        sequelize.literal(
                            `(SELECT COUNT(*) FROM bookings WHERE bookings.laundryShopId = addressDb.id)`
                        ),
                        'TotalBookingCount',
                    ],
                    [
                        sequelize.literal(
                            `(SELECT COUNT(*) FROM bookings WHERE bookings.laundryShopId = addressDb.id AND bookings.bookingStatusId NOT IN (12))`
                        ),
                        'PendingBookingCount',
                    ],
                    [
                        sequelize.literal(
                            `(SELECT ROUND(COALESCE(SUM(orderAmount), 0),2) FROM bookings WHERE bookings.laundryShopId = addressDb.id)`
                        ),
                        'TotalRevenue',
                    ]
                ],
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName', 'image', 'status']
                    },
                    {
                        model: cities,
                        attributes: ['id', 'name', 'status']
                    },
                    {
                        model: zone,
                        attributes: ['id', 'name', 'status', 'zoneMinimumAmount', 'serviceCharge']
                    }
                ]
            }
        ],
        attributes: ['id', 'shopName', 'matchProfileOptions', "otherText", 'shopAddressId', 'agentId']
    })

    let outObj = {
        AllShopsData: getShopData
    }



    return res.json(responsefunc("1", "Shop Information Data", outObj, ""))

}

/*
   * Single Shops Data
*/
async function singleShopData(req, res) {
    const { Id } = req.params

    const shopData = await bussinessInformation.findOne({
        where: {
            id: Id
        },
        include: [
            {
                model: users,
                as: 'businessInfo',
                attributes: [
                    'id',
                    'firstName',
                    'lastName',
                    'email',
                    [
                        sequelize.literal(`(SELECT COUNT(*) FROM users WHERE users.employeeOff = businessInfo.id)`),
                        'TotalEmployees',
                    ]
                ],
                include: [
                    {
                        model: bussinessWorkingHours,
                        where: {
                            status: true
                        },
                        attributes: ['id', 'dayOfWeek', 'openTime', 'closeTime']
                    },
                    {
                        model: agentSelectServices,
                        as: 'agentServices',
                        attributes: ['id'],
                        include: [
                            {
                                model: service,
                                attributes: ['id', 'name']
                            }
                        ]
                    }
                ]
            },
            {
                model: addressDb,
                attributes: ['streetAddress', 'province', 'district', 'addressType', 'cityId', 'countryId',
                    [
                        sequelize.literal(
                            `(SELECT COUNT(*) FROM bookings WHERE bookings.laundryShopId = addressDb.id)`
                        ),
                        'TotalBookingCount',
                    ],
                    [
                        sequelize.literal(
                            `(SELECT ROUND(COALESCE(SUM(orderAmount), 0),2) FROM bookings WHERE bookings.laundryShopId = addressDb.id)`
                        ),
                        'TotalRevenue',
                    ]
                ],
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName', 'image', 'status']
                    },
                    {
                        model: cities,
                        attributes: ['id', 'name', 'status']
                    },
                    {
                        model: zone,
                        attributes: ['id', 'name', 'status', 'zoneMinimumAmount', 'serviceCharge']
                    }
                ]
            }
        ]
    })

    return res.json(responsefunc("1", "Single Shop Data", shopData, ""))

}


/*
   * Get Shop Employees
*/
async function getShopEmployees(req, res) {
    const { bussinessId } = req.params

    const findEmployees = await bussinessInformation.findOne({
        where: {
            id: bussinessId
        },
        include: [
            {
                model: users,
                as: 'businessInfo',
                attributes: [
                    'id'
                    [
                    sequelize.literal(`(SELECT * FROM users WHERE users.employeeOff = businessInfo.Id)`),
                    'EmployeeData'
                    ]
                ]
            }
        ]
    })

    return res.json(responsefunc("1", "Employee Data Fetched", findEmployees, ""))

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

    return res.json(responsefunc("1", "Country Added Sucessfully", countryCreate, ""))

}

/*
   * Get Countries
*/

async function getCountries(req, res) {

    const getCountry = await countries.findAll()

    return res.json(responsefunc("1", "All Countries fetched", getCountry, ""))

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

    return res.json(responsefunc("1", "City Added Sucessfully", addCity, ""))

}

/*
   * Get Cities
*/

async function getCities(req, res) {

    const getCities = await cities.findAll()

    return res.json(responsefunc("1", "All Cities Fetched", getCities, ""))

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

    return res.json(responsefunc("1", "Zone Added Sucessfully", zoneCreate, ""))

}


/*
   * Get Zones
*/

async function getZones(req, res) {
    const zones = await zone.findAll({
        include: [
            {
                model: cities,
                attributes: ['name'],
            },
            {
                model: units,
                as: 'distanceUnitZ',
                attributes: ['name', 'symbol'],
            },
            {
                model: units,
                as: 'currencyUnitZ',
                attributes: ['name', 'symbol'],
            },
            {
                model: users,
                as: 'zoneAdmin',
                attributes: ['firstName', 'lastName'],
            }
        ]
    });

    const shopCounts = await addressDb.findAll({
        where: { addressType: 'laundaryShopAddress' },
        attributes: ['zoneId'],
        group: ['zoneId'],
        raw: true,
        logging: false,
        attributes: [
            'zoneId',
            [require('sequelize').fn('COUNT', '*'), 'shopCount']
        ]
    });

    const shopMap = shopCounts.reduce((acc, curr) => {
        acc[curr.zoneId] = parseInt(curr.shopCount, 10);
        return acc;
    }, {});

    const shapedZones = zones.map(zone => {
        const radius = calculateZoneRadius(zone.coordinates); // in km

        return {
            zoneId: zone.id,
            zoneName: zone.name,
            cityName: zone.city?.name || "",
            zoneMinimumAmount: zone.zoneMinimumAmount,
            zoneCoordinates: zone.coordinates,
            serviceCharge: zone.serviceCharge,
            zoneAdminCommission: `${zone.zoneAdminCommission}%`,
            currencyUnit: zone.currencyUnitZ ? `${zone.currencyUnitZ.name} (${zone.currencyUnitZ.symbol})` : "",
            distanceUnit: zone.distanceUnitZ ? `${zone.distanceUnitZ.name} (${zone.distanceUnitZ.symbol})` : "",
            radius: `${radius} km`,
            adminName: zone.zoneAdmin
                ? `${zone.zoneAdmin.firstName || ''} ${zone.zoneAdmin.lastName || ''}`.trim()
                : '',
            totalShops: shopMap[zone.id] || 0
        };
    });

    return res.json(
        responsefunc("1", "All Zones Fetched Successfully", shapedZones, "")
    );


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
        return res.status(404).json(responsefunc("0", "Zone not found", {}, ""));
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

    return res.json(responsefunc("1", "Zone Updated Successfully", updateZone, ""))


}







/*
 * Delete Zone
*/
async function deleteZone(req, res) {
    const { zoneId } = req.query;

    if (!zoneId) {
        return res.status(400).json(responsefunc("0", "zoneId is required", {}, ""));
    }

    const zoneToDelete = await zone.destroy({ where: { id: zoneId } });

    if (!zoneToDelete) {
        return res.status(404).json(responsefunc("0", "Zone not found", {}, ""));
    }


    return res.json(responsefunc("1", "Zone deleted successfully (soft delete)", {}, ""));
}


//!-----------------------Units Management--------------------//
async function getUnitsDistanceAndCurrency(req, res) {
    const getUnits = await units.findAll({
        where: {
            type: {
                [Op.or]: ['distance', 'currency']
            }
        },
        attributes: ['id', 'name', 'symbol', 'type', 'status']
    })
    return res.json(responsefunc("1", "All Units Fetched", getUnits, ""))
}
async function getAllUnits(req, res) {
    const getUnits = await units.findAll()
    return res.json(responsefunc("1", "All Units Fetched", getUnits, ""))
}
//!-----------------------Add Services,Categories and SubCategories --------------------//
/*

*  Add Services

*/
async function AddServices(req, res) {
    const { name, description } = req.body

    let serviceImg = null;

    if (req.file) {

        let tempImage = req.file.path;
        serviceImg = tempImage.replace(/\\/g, "/")

    }

    const serviceCreate = await service.create({
        name,
        description,
        image: serviceImg,
    })


    return res.json(responsefunc("1", "Services Added Sucessfully", serviceCreate, ""))

}


/*
*  Get All Services
*/
async function getAllServices(req, res) {

    const getServices = await service.findAll({
        where: {
            status: true,
        }
    })
    return res.json(responsefunc("1", "All Services", { services: getServices }, ""))
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

    const category = await categories.create({
        name,
        description,
        image: CategoryImg,
    })

    return res.json(responsefunc("1", "Category Added Sucessfully", category))

}


/*
  * Get All Categories
*/
async function getCategories(req, res) {

    const getCategories = await categories.findAll()

    return res.json(responsefunc("1", "All Categories Fetched", getCategories, ""))

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
        return res.json(responsefunc("0", "All selected categories are already assigned to the service.", {}, ""));
    }


    const serviceCategoriesData = newCategoryIds.map(id => ({
        serviceId: serviceId,
        categoryId: id,
        status: true
    }));


    const createData = await serviceCategories.bulkCreate(serviceCategoriesData);

    return res.json(responsefunc("1", "Service assigned to categories successfully.", { createData }, ""));
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

    return res.json(responsefunc("1", "SubCategories Added Sucessfully", createSubCategories, ""))

}


/*
  * Get SubCategories
*/
async function getSubcategories(req, res) {

    const getSubcategories = await subCategories.findAll()

    return res.json(responsefunc("1", "All SubCategories Fetched", getSubcategories, ""))
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
    return res.json(responsefunc("1", "Vehicle added", created, ""));
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
    return res.json(responsefunc("1", "Reason Added ", reasonCreate, ""))

}


/*
  *  Get All Cancel Booking Reasons
*/

async function getCancelBookingReasons(req, res) {
    const getBooking = await reason.findAll({
        attributes: ['id', 'cancelReason']
    })
    return res.json(responsefunc("1", "All Cancel Booking reasons fetched", getBooking, " "))

}

//!------------------------Admin Create Roles,Classicifations,Permissions-------------------------//
async function laundryRoles(req, res) {
    const { name, status } = req.body
    const roleCreation = await roles.create({
        name,
        status
    })

    return res.json(responsefunc("1", "Roles Added SucessFully", roleCreation, " "))

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
    return res.json(responsefunc("1", "Machine Added", createMachine, " "))

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

    return res.json(responsefunc("1", "Service Preferences Added Sucessfully", createPreferences, ""))
}

/*
  * Get Account Preferences
*/
async function getAccountPreferences(req, res) {

    const preFind = await preferencesServiceName.findAll({
        attributes: ['title', 'status']
    })

    return res.json(responsefunc("1", "All Account Preferences Fetched", preFind, ""))

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

    return res.json(responsefunc("1", "Preference Type Added", { createPreferenceType }, ""))

}

/*
  * Add Preference Values
*/
async function addPreferenceValues(req, res) {
    const { value, preferenceTypeId } = req.body;

    if (!preferenceTypeId || !value || (Array.isArray(value) && value.length === 0)) {
        return res.status(400).json(responsefunc("0", "Value(s) and preferenceTypeId are required", {}, ""));
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
        return res.status(400).json(responsefunc("0", "All preference values already exist", {}, ""));
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
  * Add Service With Preferences
*/
async function addServiceWithPreferences(req, res) {
    const { serviceId, preferenceTypeId } = req.body;

    if (!preferenceTypeId || !serviceId || (Array.isArray(serviceId) && serviceId.length === 0)) {
        return res.status(400).json(responsefunc("0", "preferenceTypeId and serviceId(s) are required", {}, ""));
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
        return res.status(400).json(responsefunc("0", "All Services already mapped to this Preference", {}, ""));
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
    const getPreferenceTypes = await preferenceTypes.findAll({
        where: {
            status: true
        },
        include: [
            {
                model: preferenceValues,
                as: 'preferenceValues',
                where: {
                    status: true
                },
                required: false,
                order: [['id', 'DESC']],
                attributes: ['id', 'value', 'status']
            }
        ],
        attributes: ['id', 'name', 'status']
    })
    return res.json(responsefunc("1", "All Preference Types Fetched", getPreferenceTypes, ""))
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

    return res.json(responsefunc("1", "on Hold Options Created", optionsCreate, ""))


}


/*
  * Get On Hold Options
*/

async function getOnHoldOptions(req, res) {

    const getOptions = await onHoldOption.findAll({
        where: {
            status: true
        },
        attributes: ['id', 'option', 'status']
    })

    return res.json(responsefunc("1", "All on Hold Options Fetched", getOptions, ""))

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


    return res.json(responsefunc("1", "Customer Hold Option", optionsCreate, ""))
}


/*
  * Get On Hold Customer Options
*/
async function getOnHoldCustomerOptions(req, res) {

    const optionsFound = await onHoldCustomerOption.findAll({
        include: [{
            model: onHoldOption,
            where: {
                status: true
            },
            attributes: ['id', 'option', 'status']
        }],
        attributes: ['id', 'option', 'title', 'conformationText', 'notConfirmText', 'onHoldOptionId']
    })

    return res.json(responsefunc("1", "All Options Fetched", optionsFound, ""))

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
    //-------------Services--------//
    getAllServices,
    AddServices,
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
    AddServicePreferences,
    getAccountPreferences,
    createPreferenceType,
    addPreferenceValues,
    addServiceWithPreferences,
    getPreferenceTypes,
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
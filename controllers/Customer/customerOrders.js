require("dotenv").config();
const {
    users,
    userType,
    booking,
    otpVerification,
    deviceToken,
    bookingHistory,
    billingDetails,
    categories,
    subCategories,
    addressDb,
    customerSelectedService,
    bookingStatus,
    service,
    zone,
    OnHoldConfirmation,
    proofOfDeliveries,
    bussinessInformation,
    onHoldOption,
    onHoldCustomerOption,
    serviceCategories,
    servicePreferences,
    countries,
    agentSelectServices,
    cities,
} = require("../../models");
const sequelize = require("sequelize");
const { Op } = require("sequelize");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
var JSbarcode = require("jsbarcode");
const redisCli = require("../../redis/redis");
const otpGenerator = require("otp-generator");
const customError = require("../../middlewares/customError");
const otpMail = require("../../helper/otpMail");
const error = require("../../middlewares/error");
const path = require("path");
const { stat, rmSync } = require("fs");
const stripe = require("../stripe");
const { request } = require("http");
const checkServiceAvailability = require("../../utils/haversineFormula");
const { literal, fn, col } = require("sequelize");
const getdistance = require("../../utils/distanceCalculator");
const { sendEvent } = require("../../socket_io");
const { title } = require("process");
const { confirmIntend, paymentIntentGet, createPaymentIntend,getIntent,attachPaymentMethodToCustomer } = require("../stripe");
const { sendNotification } = require("../../utils/notification");
const customerOrderService = require('../../services/Customer/customerOrderService');
const cancelBookingService = require('../../services/Customer/cancelBookingService');
const ResponseHelper = require('../../utils/responseHelper');
const { ValidationError } = require('../../middlewares/universalErrorHandler');
const {
    serviceManagementService,
} = require('../../services/Admin');

const customerPostcodeService = require('../../services/Customer/customerPostcodeService');

//!------------------------Boooking Management-------------------------------//
/*
 *   Customer Create Booking
 */

async function createBooking(req, res) {
    const {
        collectionDate,
        collectionTimeFrom,
        collectionTimeTo,
        driverInstruction,
        frequency,
        deliveryDate,
        deliveryTimeFrom,
        deliveryTimeTo,
        pickUpAddress,
        dropOffAddress,
        addNewAddress,
        addNewDropOffAddress,
        dropOffSamePickUp,
        dropOffAddressId,
        pickUpAddressId,
        services,
        totalItems,
        addressId,
        driverInstructionOptions,
        driverInstructionOptions1,
        preferencesArray,
        setupIntentId,
        paymentMethodId,
        stripeCustomerId,
        tipAmount
    } = req.body;

    const userId = req.user.id;

    // Call service to handle business logic
    // NOTE: Both setupIntentId and paymentMethodId are saved.
    // Payment will be charged at Status 4 using paymentMethodId.
    const result = await customerOrderService.createBooking({
        collectionDate,
        collectionTimeFrom,
        collectionTimeTo,
        driverInstruction,
        frequency,
        deliveryDate,
        deliveryTimeFrom,
        deliveryTimeTo,
        pickUpAddress,
        dropOffAddress,
        addNewAddress,
        addNewDropOffAddress,
        dropOffSamePickUp,
        dropOffAddressId,
        pickUpAddressId,
        services,
        totalItems,
        addressId,
        driverInstructionOptions,
        driverInstructionOptions1,
        preferencesArray,
        setupIntentId,
        paymentMethodId,
        stripeCustomerId,
        tipAmount
    }, userId);

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, {});
}

/*
 * Payment Intent Confirm
 */
async function updateBookingUpfrontAmount(req, res) {
    const { bookingId, IntentId } = req.query;

    // Call service to handle business logic
    const result = await customerOrderService.updateBookingUpfrontAmount({
        bookingId,
        IntentId
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, {});
}

/*
 * Show Customer On Hold Reason
 */
async function onHoldCustomerShow(req, res) {
    const { bookingId } = req.body;

    // Call service to handle business logic
    const result = await customerOrderService.onHoldCustomerShow({
        bookingId
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, result.data);
}

/*
 *   on Hold Laundry Customer response Updated
 */
async function customerResponseUpdate(req, res) {
    const { bookingId, customerResponse } = req.body;

    // Call service to handle business logic
    const result = await customerOrderService.customerResponseUpdate({
        bookingId,
        customerResponse
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, {});
}

/*
 * Customer All bookings
 */
async function allBookings(req, res) {
    const userId = req.user.id;

    // Call service to handle business logic
    const result = await customerOrderService.allBookings({
        userId
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, result.data);
}

/*
 * Customer booking Detail
 */
async function bookingDetailsById(req, res) {
    const { bookingId, orderTrackId } = req.query;

    // Call service to handle business logic
    const result = await customerOrderService.bookingDetailsById({
        bookingId,
        orderTrackId
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, result.data);
}

/*
 * Services For the Customer
 */
async function allServices(req, res) {
    // Call service to handle business logic
    const result = await customerOrderService.allServices();

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, result.data);
}

/*
 *  Specific Service Detail For the Customer
 */
async function serviceDetail(req, res) {
    // Call service to handle business logic
    const result = await customerOrderService.serviceDetail();

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, result.data);
}

/*
 *  Customer Addresses
 */
async function customerAddresses(req, res) {
    const userId = req.user.id;

    // Call service to handle business logic
    const result = await customerOrderService.customerAddresses({
        userId
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, result.data);
}

/*
 *  fetch Specific Zone and Charges
 */
async function fetchZoneAndCharges(req, res) {
    const { lat, lng } = req.query;
    const result = await customerOrderService.fetchZoneAndCharges({
        lat,
        lng
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, result.data);
}


/*
 *  Create Intent Using Stripe
 */
async function createIntentUsingStripe(req, res) {
    console.log("=== Create Setup Intent Using Stripe ===");
    console.log("Request Body:", JSON.stringify(req.body, null, 2));
    console.log("User ID:", req.user?.id);
    
    const { customerId } = req.body;

    // Validate required fields in controller
    if (!customerId) {
        throw new ValidationError('Customer ID is required');
    }

    // Call service to handle business logic
    // NOTE: Setup Intent is created to save payment method without charging
    // Payment will be charged later when booking reaches laundry shop (status 8)
    const result = await customerOrderService.createIntentUsingStripe({
        customerId
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, result.data);
}


/*
 *  Get Service Preferences
 */
async function getPrefrencesValues(req, res) {
    const typeEnumValues = servicePreferences.rawAttributes.type.values;
    const chooseTemperatureEnumValues =
        servicePreferences.rawAttributes.chooseTemperature.values;

    console.log("Type Enum Values:", typeEnumValues);
    console.log("Choose Temperature Enum Values:", chooseTemperatureEnumValues);

    return res.json(
        responsefunc(
            "1",
            "Data fetched",
            { type: typeEnumValues, chooseTemperature: chooseTemperatureEnumValues },
            ""
        )
    );
}

/*
 * Get All On-Hold Bookings
 */
async function getOnHoldBookings(req, res) {
    const { bookingId } = req.params;

    // Call service to handle business logic
    const result = await customerOrderService.getOnHoldBookings({
        bookingId
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, result.data);
}



/*
 * Update Customer response for on hold booking
 */
async function updateCustomerResponseForOnHoldBooking(req, res) {
    const { responses, bookingId } = req.body;

    // Call service to handle business logic
    const result = await customerOrderService.updateCustomerResponseForOnHoldBooking({
        responses,
        bookingId
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, result.data);
}


/*
 * Get All Bookings with On-Hold Status for a Customer
 */
async function getOnHoldBookingsForCustomer(req, res) {
    const customerId = req.user.id;

    // Call service to handle business logic
    const result = await customerOrderService.getOnHoldBookingsForCustomer({
        customerId
    });

    // Return response using ResponseHelper success method
    return ResponseHelper.success(res, result.message, result.data);
}


/*
 * Get All Service With Preferences
 */
async function getAllServiceWithPreferenceDetails(req, res) {
    const { serviceId } = req.params;
    const getData = await serviceManagementService.getAllPreferenceTypesAndServiceDetails(serviceId);
    return ResponseHelper.success(res, "All Preferences and Services Data Fetched", getData);
}

/*
 * Get All Order Status
 */
async function getAllOrderStatus(req, res) {
    const result = await customerOrderService.allOrderStatus();
    return ResponseHelper.success(res, result.message, result.data);
}


/*
 * Cancel Customer Booking with Policy Enforcement
 */
async function cancelCustomerBooking(req, res) {
    const { bookingId, reasonId, reasonText } = req.body;
    const customerId = req.user.id;

    if (!bookingId) {
        throw new customError("Booking ID is required");
    }

    if (!reasonText || reasonText.trim() === '') {
        throw new customError("Cancellation reason is required");
    }

    const result = await cancelBookingService.cancelCustomerBooking(
        bookingId,
        customerId,
        reasonId,
        reasonText
    );

    return ResponseHelper.success(res, "Booking cancelled successfully", result);
}

/*
 * Get Customer Cancellation History
 */
async function getCustomerCancellationHistory(req, res) {
    const customerId = req.user.id;
    const days = parseInt(req.query.days) || 30;

    const history = await cancelBookingService.getCustomerCancellationHistory(customerId, days);

    return ResponseHelper.success(res, "Cancellation history fetched successfully", history);
}

/*
 * Test Notification
 */
async function testNotification(req, res) {
    const { userId, title, body, data } = req.body;

    try {
        await sendNotification(userId, title, body, data);
        return res.json(responsefunc("1", "Test notification sent successfully", {}, ""));
    } catch (error) {
        console.error("Error sending test notification:", error);
        return res.status(500).json(responsefunc("0", "Failed to send test notification", {}, ""));
    }
}
//!---------------------------------Recurring functions------------------------>>>>>
async function addressAdder(
    addNew,
    address,
    type,
    userId,
    addressId,
    cityId,
    countryId
) {
    console.log("Address Data------>", address.lat);
    console.log("Address Data------>", address.lng);
    console.log("City ID----------->", cityId);
    console.log("Country ID-------->", countryId);

    if (addNew) {
        await addressDb.update({ isDefault: false }, { where: { userId } });

        const dropOffAddressData = await addressDb.create({
            ...address,
            userId,
            type,
            cityId,
            countryId,
            isDefault: true,
        });

        if (address.save) {
            await addressDb.update(
                {
                    userId,
                    type,
                    cityId,
                    countryId,
                },
                { where: { id: dropOffAddressData.id } }
            );
        }

        return dropOffAddressData.id;
    } else {
        return addressId;
    }
}

let responsefunc = (status, message, data, error) => {
    return {
        status: `${status}`,
        message: `${message}`,
        data: data,
        error: `${error}`,
    };
};

async function findZones(lat, lng) {
    const findZone = await zone.findAll({
        where: {
            status: true,
            coordinates: sequelize.where(
                sequelize.fn(
                    "ST_Contains",
                    sequelize.col("coordinates"),
                    sequelize.fn("ST_GeomFromText", `POINT(${lng} ${lat})`)
                ),
                true
            ),
        },
        include: [
            {
                model: cities,
                attributes: ["id", "name", "lat", "lng", "status"],
                include: [
                    {
                        model: countries,
                        attributes: ["id", "name", "shortName", "status"],
                    },
                ],
            },
        ],
    });

    if (findZone.length === 0) {
        throw new customError("No Zone found for these lat,lngs and coordinates");
    }

    return findZone;
}

async function checkIfTimeSlotBooked(
    shopId,
    deliveryTimeFrom,
    deliveryTimeTo,
    collectionTimeFrom,
    collectionTimeTo,
    zoneId
) {
    console.log("ðŸš€ ~ checkIfTimeSlotBooked ~ shopId:", shopId);

    const existingTimeSlots = await booking.findAll({
        where: {
            laundryShopId: shopId,
            [Op.or]: [
                {
                    deliveryDate: fn("DATE", col("deliveryDate")),
                    bookingStatusId: 1,
                    [Op.and]: [
                        { deliveryTimeFrom: { [Op.gte]: deliveryTimeFrom } },
                        { deliveryTimeTo: { [Op.lte]: deliveryTimeTo } },
                    ],
                },
                {
                    collectionDate: fn("DATE", col("collectionDate")),
                    bookingStatusId: 1,
                    [Op.and]: [
                        { collectionTimeFrom: { [Op.gte]: collectionTimeFrom } },
                        { collectionTimeTo: { [Op.lte]: collectionTimeTo } },
                    ],
                },
            ],
        },
        include: [
            {
                model: users,
                as: "customer",
                attributes: ["id", "firstName", "LastName", "email"],
            },
            {
                model: addressDb,
                as: "laundryShop",
                where:{
                    zoneId:zoneId,
                },
                attributes: [
                    "title",
                    "customAddresstitle",
                    "streetAddress",
                    "district",
                    "province",
                    "lat",
                    "lng",
                    "status",
                    "addressType",
                    "coordinates",
                ],
                include: [
                    {
                        model: users,
                        attributes: ["id", "firstName", "lastName", "email", "phoneNum"],
                    },
                    {
                        model: zone,
                        required: true,
                        attributes: ["id", "name", "status", "coordinates"],
                    },
                ],
            },
        ],
    });

    // console.log(
    //     "ðŸš€ ~ checkIfTimeSlotBooked ~ existingTimeSlots:",
    //     existingTimeSlots
    // );

    return existingTimeSlots;
}

async function bookingEventSentCheckTheShops(
    bookingId,
    zoneId,
    collectionDate,
    collectionTimeTo,
    collectionTimeFrom,
    deliveryDate,
    deliveryTimeTo,
    deliveryTimeFrom,
    services
) {
    console.log(collectionTimeTo);
    console.log(collectionTimeFrom);
    console.log(deliveryDate);
    console.log(deliveryTimeTo);
    console.log(deliveryTimeFrom);

    let getShopsAndOwners = await addressDb.findAll({
        where: {
            zoneId: zoneId,
            addressType: "LaundaryShopAddress",
        },
        include: [
            {
                model: users,
                attributes: ["id", "firstName", "email", "lastName"],
                include:[
                    {
                        model: agentSelectServices,
                        as: "agentServices",
                        where: {
                            serviceId: {
                                [Op.in]: services.map(service => service.serviceId)
                            }
                        },
                        attributes: ['id']
                    }
                ],
                include: [
                    {
                        model: bussinessInformation,
                        as: "businessInfo",
                        attributes: ["shopName"],
                    },
                ],
            },
        ],
        attributes: ["id", "status", "zoneId", "userId"],
    });

    console.log(
        "ðŸš€ ~ getBookingDetails ~ getShopsAndOwners ----------------->:",
        getShopsAndOwners
    );

    let availableShops = [];

    for (let shop of getShopsAndOwners) {
        let checkSlots = await checkIfTimeSlotBooked(
            shop.id,
            deliveryDate,
            collectionTimeTo,
            collectionTimeFrom,
            collectionDate,
            deliveryTimeTo,
            deliveryTimeFrom,
            zoneId
        );
        console.log("ðŸš€ ~ getBookingDetails ~ checkSlots:", checkSlots);
        if (!checkSlots || checkSlots.length === 0) {
            availableShops.push(shop);
        }
    }

    console.log("ðŸš€ ~ getBookingDetails ~ availableShops:", availableShops);

    if (availableShops.length > 0) {
        const bookingDetails = await booking.findOne({
            where: { id: bookingId },
            include: [
                {
                    model: users,
                    as: "customer",
                    attributes: ["id", "firstName", "lastName", "email", "phoneNum"],
                },
                {
                    model: addressDb,
                    as: "pickupAddress",
                    attributes: ["id", "streetAddress", "district", "province", "postalcode", "lat", "lng", "addressType"],
                },
                {
                    model: billingDetails,
                    attributes: ["total", "serviceCharge", "categoryCharge"],
                },
                {
                    model: customerSelectedService,
                    include: [
                        {
                            model: service,
                            attributes: ["id", "name", "status"],
                        },
                        {
                            model: categories,
                            attributes: ["id", "name", "status"],
                        },
                        {
                            model: subCategories,
                            attributes: ["id", "name", "status"],
                        },
                    ],
                },
                {
                    model: zone,
                    attributes: [
                        "id",
                        "zoneMinimumAmount",
                        "serviceCharge",
                        "currencyUnitId",
                    ],
                },
            ],
        });

        console.log("ðŸš€ ~ getBookingDetails ~ bookingDetails:", bookingDetails);

        const customerService =
            bookingDetails.customerSelectedServices.length > 0
                ? bookingDetails.customerSelectedServices.map((serviceItem) => ({
                    serviceId: serviceItem.service.id,
                    serviceName: serviceItem.service.name,
                    serviceStatus: serviceItem.service.status,
                    categoryId: serviceItem?.category?.id,
                    categoryName: serviceItem?.category?.name,
                    categoryStatus: serviceItem?.category?.status,
                    subCategoryId: serviceItem?.subCategory?.id,
                    subCategoryName: serviceItem?.subCategory?.name,
                    subCategoryStatus: serviceItem?.subCategory?.status,
                }))
                : [];

        // const eventData = {
        //     type: 'newBookingRequest',
        //     data: {
        //         shopId: availableShops[0].id,
        //         shopName: availableShops[0]?.user?.businessInfo?.shopName,
        //         owner: availableShops[0].user.firstName + ' ' + availableShops[0].user.lastName,
        //         ownerEmail: availableShops[0].user.email,
        //         zoneId: availableShops[0].zoneId,
        //         bookingId: bookingId,
        //         customer: {
        //             firstName: bookingDetails.customer.firstName,
        //             lastName: bookingDetails.customer.lastName,
        //             email: bookingDetails.customer.email,
        //             phoneNum: bookingDetails.customer.phoneNum
        //         },
        //         orderDetails: {
        //             orderTrackId: bookingDetails.orderTrackId,
        //             collectionDate: collectionDate,
        //             collectionTimeTo: collectionTimeTo,
        //             collectionTimeFrom: collectionTimeFrom,
        //             deliveryDate: deliveryDate,
        //             deliveryTimeTo: deliveryTimeTo,
        //             deliveryTimeFrom: deliveryTimeFrom,
        //             totalAmount: bookingDetails?.billingDetail?.total,
        //             serviceCharge: bookingDetails?.zone?.serviceCharge,
        //             categoryCharge: bookingDetails?.billingDetail?.categoryCharge,
        //             upfrontAmount: bookingDetails?.zone?.zoneMinimumAmount,
        //         },
        //         customerServices: {
        //             services: customerService
        //         }
        //     }
        // };
        const eventData = {
            type: "newBookingRequest",
            data: {
                id: bookingDetails.id,
                orderTrackId: bookingDetails.orderTrackId,
                collectionDate: new Date(collectionDate).toISOString(),
                collectionTimeTo,
                collectionTimeFrom,
                deliveryDate: new Date(deliveryDate).toISOString(),
                deliveryTimeTo,
                deliveryTimeFrom,
                driverInstructionOptions:
                    bookingDetails.driverInstructionOptions || null,
                driverInstructionOptions1:
                    bookingDetails.driverInstructionOptions1 || null,
                driverInstruction: bookingDetails.driverInstruction || null,
                paymentConfirmed: bookingDetails.paymentConfirmed || false,
                partialPayment: bookingDetails.partialPayment || false,
                totalItems: bookingDetails.totalItems || 0,
                orderAmount: bookingDetails?.billingDetail?.total || 0,
                frequency: bookingDetails.frequency || "Just Once",
                orderExpireTime: bookingDetails.orderExpireTime || null,
                pickupAddresId: bookingDetails.pickupAddresId || null,
                dropOffAddressId: bookingDetails.dropOffAddressId || null,
                laundryShopId: availableShops[0]?.id || null,
                customerId: bookingDetails.customer.id,
                pickupAddress: bookingDetails.pickupAddress || {},
                customer: {
                    id: bookingDetails.customer.id,
                    firstName: bookingDetails.customer.firstName,
                    lastName: bookingDetails.customer.lastName,
                    email: bookingDetails.customer.email,
                    userTypeId: bookingDetails.customer.userTypeId || 2,
                    image: bookingDetails.customer.image || null,
                    phoneNum: bookingDetails.customer.phoneNum,
                },
                zone: bookingDetails.zone || {},
            },
        };
        availableShops.forEach((shop) => {
            sendEvent(shop.user.id, eventData);
        });
    }
}


function getTimePlusMinutes(mins = 40) {
    const dt = new Date(Date.now() + mins * 60000);
    return dt.toLocaleTimeString("en-GB", {
        timeZone: "Asia/Karachi",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
    });
}

//!--------------------------------------------------------------------------------------------------------------->>>

/**
 * ====================================
 * POSTCODE ADDRESS LOOKUP ENDPOINTS
 * ====================================
 */

/**
 * Get addresses by UK postcode using getAddress.io API
 * @route GET /api/customer/postcode/:postcode
 * @access Private (Customer only)
 * @param {string} postcode - UK postcode parameter (e.g., "SW1A1AA")
 * @returns {Object} - List of addresses for the given postcode with coordinates
 * @description Fetches all addresses associated with a UK postcode for address selection during booking
 */
const getAddressesByPostcode = async (req, res) => {
    const { postcode } = req.params;
    
    if (!postcode) {
        throw new customError('Postcode is required', 400);
    }

    const result = await customerPostcodeService.getAddressesByPostcode(postcode);
    
    return res.json({
        status: "1",
        message: "Addresses fetched successfully",
        statusCode: 200,
        data: result,
        error: "",
        timestamp: new Date().toISOString()
    });
};

/**
 * Get specific address details by postcode and index
 * @route GET /api/customer/postcode/:postcode/address/:index
 * @access Private (Customer only)
 * @param {string} postcode - UK postcode parameter
 * @param {number} index - Address index from the address list
 * @returns {Object} - Specific address details with coordinates
 * @description Retrieves detailed information for a specific address after customer selection
 */
const getAddressById = async (req, res) => {
    const { postcode, index } = req.params;
    
    if (!postcode) {
        throw new customError('Postcode is required', 400);
    }
    
    if (!index) {
        throw new customError('Address index is required', 400);
    }
    
    const result = await customerPostcodeService.getAddressById(postcode, index);
    
    return res.json({
        status: "1",
        message: "Address details fetched successfully",
        statusCode: 200,
        data: result,
        error: "",
        timestamp: new Date().toISOString()
    });
};

/**
 * Validate UK postcode format
 * @route POST /api/customer/postcode/validate
 * @access Private (Customer only)
 * @body {string} postcode - UK postcode to validate
 * @returns {Object} - Validation result with normalized postcode
 * @description Validates UK postcode format before making API calls
 */
const validatePostcode = async (req, res) => {
    const { postcode } = req.body;
    
    if (!postcode) {
        throw new customError('Postcode is required', 400);
    }

    const result = customerPostcodeService.validatePostcodeFormat(postcode);
    
    return res.json({
        status: result.isValid ? "1" : "0",
        message: result.message,
        statusCode: result.isValid ? 200 : 400,
        data: result,
        error: result.isValid ? "" : result.message,
        timestamp: new Date().toISOString()
    });
};

module.exports = {
    createBooking,
    onHoldCustomerShow,
    allBookings,
    bookingDetailsById,
    customerResponseUpdate,
    getPrefrencesValues,
    //---------Services----------//
    allServices,
    serviceDetail,
    //---Customer Addresses----//
    customerAddresses,
    updateBookingUpfrontAmount,
    fetchZoneAndCharges,
    createIntentUsingStripe,
    getOnHoldBookings,
    updateCustomerResponseForOnHoldBooking,
    getOnHoldBookingsForCustomer,
    testNotification,
    getAllServiceWithPreferenceDetails,
    getAllOrderStatus,
    cancelCustomerBooking,
    getCustomerCancellationHistory,
    //---Customer Postcode Address Lookup----//
    getAddressesByPostcode,
    getAddressById,
    validatePostcode
};

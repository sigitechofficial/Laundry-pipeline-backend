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
const { confirmIntend, paymentIntentGet, createPaymentIntend,getIntent } = require("../stripe");

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
        paymentMethodId,
        paymentIntentId,
    } = req.body;

    console.log("ðŸš€ ~ createBooking ~ req.body:", req.body);

    const userId = req.user.id;
    let userAddressId;
    let userPickUpAddressId;
    let userDropOffAddressId;

    // console.log("Lat -------------->", pickUpAddress.lat);
    // console.log("Lng ---------------------->", pickUpAddress.lng);

    let findZone = await findZones(pickUpAddress.lat, pickUpAddress.lng);
    let zoneId = findZone[0].id;
    let zoneUpfrontAmount = findZone[0].zoneMinimumAmount;
    let zoneSeviceCharge = findZone[0].serviceCharge;
    let cityId = findZone[0].city.id;
    let countryId = findZone[0].city.country.id;
    console.log(
        "ðŸš€ ~ createBooking ~ findZone:==============================",
        zoneId
    );
    console.log(
        "ðŸš€ ~ createBooking ~ findZone:------------------------------",
        zoneUpfrontAmount
    );
    console.log(
        "ðŸš€ ~ createBooking ~ findZone:======================+++++++++",
        zoneSeviceCharge
    );

    //return res.json(findZone)

    if (addNewAddress || !pickUpAddressId) {
        userAddressId = await addressAdder(
            addNewAddress,
            pickUpAddress,
            "pickUp",
            userId,
            pickUpAddressId,
            cityId,
            countryId
        );
        userPickUpAddressId = userAddressId;
    } else {
        userPickUpAddressId = pickUpAddressId;
    }

    if (dropOffSamePickUp === true) {
        userDropOffAddressId = userPickUpAddressId;
    } else if (addNewDropOffAddress || !dropOffAddressId) {
        userDropOffAddressId = await addressAdder(
            addNewAddress,
            dropOffAddress,
            "dropOff",
            userId
        );
    } else {
        userDropOffAddressId = dropOffAddressId;
    }

    const orderTrackingId = otpGenerator.generate(6, {
        lowerCaseAlphabets: false,
        upperCaseAlphabets: false,
        specialChars: false,
    });

    const bookingData = await booking.create({
        collectionDate,
        collectionTimeFrom,
        collectionTimeTo,
        driverInstruction,
        frequency,
        deliveryDate,
        deliveryTimeFrom,
        deliveryTimeTo,
        customerId: userId,
        bookingStatusId: 1,
        pickupAddresId: userPickUpAddressId,
        dropOffAddressId: userDropOffAddressId,
        totalItems: totalItems || 0,
        paymentConfirmed: false,
        partialPayment: false,
        zoneId: zoneId,
        driverInstructionOptions,
        driverInstructionOptions1,
        subTotal: 0,
        paymentMethodId: paymentMethodId,
        paymentIntentId: paymentIntentId,
    });

    const createPreferences = preferencesArray.map((preferences) => ({
        type: preferences.type,
        chooseTemperature: preferences.chooseTemperature,
        serviceId: preferences.serviceId,
        preferencesServiceNameId: preferences.preferencesServiceNameId,
        numberOfBags: preferences.numberOfBags,
        bookingId: bookingData.id,
    }));

    await servicePreferences.bulkCreate(createPreferences);

    let total = 0;
    let categoryCharge = 0;

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    const currentDate = new Date().toISOString().split("T")[0];
    console.log(currentDate);
    console.log(currentTime);

    const discount = 0;
    if (services && services.length > 0) {
        categoryCharge = services.reduce(
            (acc, service) => acc + parseFloat(service.categoryCharge || 0),
            0
        );
        // Calculate total amount
        total = categoryCharge;

        // Prepare the serviceData to be inserted
        const serviceData = services.map((service) => {
            let serviceObj = {
                bookingId: bookingData.id,
                serviceId: service.serviceId,
                date: currentDate,
                time: currentTime,
            };
            if (service.categoryId) serviceObj.categoryId = service.categoryId;
            if (service.subCategoryId) serviceObj.categoryId = service.categoryId;
            if (service.categoryCharge) serviceObj.categoryPrice = total;

            return serviceObj;
        });
        console.log("ðŸš€ ~ createBooking ~ serviceData:", serviceData);
        let serviceCreate = await customerSelectedService.bulkCreate(serviceData);
        console.log("ðŸš€ ~ createBooking ~ serviceCreate:", serviceCreate);
    } else if (services.length === 0) {
        throw new customError(
            "Cannot Continue without Selection of Service Types",
            "Select Minimum one Service Type"
        );
    }

    const ordertrackingNumber = `${bookingData.id}-${orderTrackingId}`;
    const upfrontAmount = zoneUpfrontAmount;
    console.log("ðŸš€ ~ createBooking ~ upfrontAmount:", upfrontAmount);

    // const fixTimeKey = new Date(Date.now() + 40 * 60 * 1000).toLocaleTimeString(
    //     'en-GB',
    //     {
    //         hour12: false, // Forces 24-hour format
    //         hour: "2-digit",
    //         minute: "2-digit",
    //     }
    // );

    const fixTimeKey = getTimePlusMinutes();
    console.log(
        "ðŸš€ ~ createBooking ~ fixTimeKey===============+++++++++++++++++++++++++++:",
        fixTimeKey
    );

    // Create the billing details
    await billingDetails.create({
        bookingId: bookingData.id,
        upfrontAmount,
        discount,
        paymentStatus: "Pending",
    });

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingData.id,
        bookingStatusId: 1,
    });

    await booking.update(
        {
            orderAmount: total || 0,
            orderTrackId: ordertrackingNumber,
            orderExpireTime: fixTimeKey,
            partialPayment: true,
        },
        { where: { id: bookingData.id } }
    );

    let bookingId = bookingData.id;
    bookingEventSentCheckTheShops(
        bookingId,
        zoneId,
        collectionDate,
        collectionTimeTo,
        collectionTimeFrom,
        deliveryDate,
        deliveryTimeTo,
        deliveryTimeFrom
    );

    return res.json(responsefunc("1", "Booking Created", {}, ""));
}

/*
 * Payment Intent Confirm
 */
async function updateBookingUpfrontAmount(req, res) {
    const { bookingId, IntentId } = req.query;

    const intentDataGet = await getIntent(IntentId);
    console.log("🚀 ~ updateBookingUpfrontAmount ~ intentDataGet:", intentDataGet)

    if (intentDataGet.status === "succeeded") {
        await booking.update(
            {
                partialPayment: true,
            },
            { where: { id: bookingId } }
        );
    } else {
        throw new customError("Intent Not Get");
    }

    return res.json(responsefunc("1", "Payment Updated Sucessfully", {}, ""));
}

/*
 * Show Customer On Hold Reason
 */
async function onHoldCustomerShow(req, res) {
    const { bookingId } = req.body;

    const userFound = await booking.findOne({
        where: {
            id: bookingId,
        },
        include: [
            {
                model: users,
                as: "customer",
                attributes: ["id", "email"],
            },
        ],
    });
    console.log("ðŸš€ ~ onHoldCustomerShow ~ userFound:", userFound.customer.id);

    const optionIdFound = await OnHoldConfirmation.findOne({
        where: {
            bookingId: bookingId,
        },
        include: [
            {
                model: onHoldOption,
                as: "agentHoldId",
            },
        ],
        attributes: ["onHoldOptionId"],
    });
    console.log("ðŸš€ ~ onHoldCustomerShow ~ optionIdFound:", optionIdFound);

    const customerOptionFound = await onHoldCustomerOption.findOne({
        where: {
            onHoldOptionId: optionIdFound.onHoldOptionId,
        },
        attributes: ["id", "option", "title", "conformationText", "notConfirmText"],
    });

    return res.json(
        responsefunc("1", "Customer On Hold Response Show", customerOptionFound, "")
    );
}

/*
 *   on Hold Laundry Customer response Updated
 */
async function customerResponseUpdate(req, res) {
    const { bookingId, customerResponse } = req.body;

    const bookingFind = await booking.findOne({
        where: {
            id: bookingId,
        },
        include: [
            {
                model: addressDb,
                as: "laundryShop",
                attributes: ["id", "userId"],
                include: [
                    {
                        model: users,
                        attributes: ["id", "firstName", "lastName", "userTypeId"],
                    },
                ],
            },
        ],
    });
    console.log(
        "ðŸš€ ~ customerResponseUpdate ~ bookingFind:",
        bookingFind.laundryShop.user.id
    );
    const userId = bookingFind.laundryShop.user.id;
    //return res.json(bookingFind)

    await OnHoldConfirmation.update(
        {
            customerResponse: customerResponse,
        },
        { where: { bookingId: bookingId } }
    );

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    const currentDate = new Date().toISOString().split("T")[0];

    await booking.update(
        {
            bookingStatusId: 22,
        },
        { where: { id: bookingId } }
    );

    await bookingHistory.create({
        bookingId: bookingId,
        bookingStatusId: 22,
        date: currentDate,
        time: currentTime,
    });

    let eventData = {
        type: "customerResponse",
        data: {
            customerResponse: customerResponse,
            bookingId: bookingId,
        },
    };

    sendEvent(userId, eventData);
    //two options can send event for new tab or can send notification from here

    return res.json(responsefunc("1", "Customer Response", {}, ""));
}

/*
 * Customer All bookings
 */
async function allBookings(req, res) {
    const userId = req.user.id;

    const findAllBooking = await booking.findAll({
        where: {
            customerId: userId,
        },
        include: [
            {
                model: users,
                as: "customer",
                attributes: ["firstName", "lastName", "email"],
            },
            {
                model: addressDb,
                as: "pickupAddress",
                attributes: ["title", "streetAddress", "province", "addressType"],
            },
            {
                model: addressDb,
                as: "dropOffAddress",
                attributes: ["title", "streetAddress", "province", "addressType"],
            },
            {
                model: bookingStatus,
                attributes: ["title", "description"],
            },
        ],
    });

    return res.json(
        responsefunc("1", "Customer All Bookings", findAllBooking, "")
    );
}

/*
 * Customer booking Detail
 */
async function bookingDetailsById(req, res) {
    const { bookingId, orderTrackId } = req.query;

    let whereCondition = {};

    if (bookingId) {
        whereCondition.id = bookingId;
    } else {
        whereCondition.orderTrackId = orderTrackId;
    }

    const bookingFind = await booking.findOne({
        where: whereCondition,
        include: [
            {
                model: users,
                as: "customer",
                attributes: ["id", "firstName", "lastName", "email"],
            },
            {
                model: addressDb,
                as: "pickupAddress",
                attributes: [
                    "title",
                    "streetAddress",
                    "province",
                    "district",
                    "addressType",
                ],
            },
            {
                model: addressDb,
                as: "dropOffAddress",
                attributes: [
                    "title",
                    "streetAddress",
                    "province",
                    "district",
                    "addressType",
                ],
            },
            {
                model: customerSelectedService,
                attributes: [
                    "date",
                    "time",
                    "categoryprice",
                    "categoryId",
                    "serviceId",
                    "subCategoryId",
                    "items",
                ],
            },
            {
                model: bookingStatus,
                attributes: ["title", "description"],
            },
            {
                model: bookingHistory,
                attributes: ["date", "time"],
                include: [
                    {
                        model: bookingStatus,
                        attributes: ["title", "description"],
                    },
                ],
            },
        ],
    });

    return res.json(
        responsefunc("1", "Customer Order Details Fetched", bookingFind, "")
    );
}

/*
 * Services For the Customer
 */
async function allServices(req, res) {
    const serviceData = await service.findAll();

    return res.json(responsefunc("1", " All Services", { serviceData }, ""));
}

/*
 *  Specific Service Detail For the Customer
 */
async function serviceDetail(req, res) {
    const { serviceId } = req.params;

    const serviceData = await serviceCategories.findAll({
        where: {
            serviceId: serviceId,
            status: true,
        },
        include: [
            {
                model: service,
                attributes: ["id", "name", "status"],
            },
            {
                model: categories,
                attributes: ["id", "name", "status", "image", "description"],
                include: [
                    {
                        model: subCategories,
                        attributes: ["id", "name", "status", "price"],
                    },
                ],
            },
        ],
    });

    return res.json(responsefunc("1", "Service Details", { serviceData }, ""));
}

/*
 *  Customer Addresses
 */
async function customerAddresses(req, res) {
    const userId = req.user.id;

    const customerAddresses = await addressDb.findAll({
        where: {
            userId: userId,
            isDefault: true,
        },
        attributes: [
            "id",
            "title",
            "streetAddress",
            "province",
            "district",
            "addressType"
        ],
    });

    return res.json(
        responsefunc("1", "Customer Addresses", customerAddresses, "")
    );
}

/*
 *  fetch Specific Zone and Charges
 */
async function fetchZoneAndCharges(req, res) {
    const { lat, lng } = req.query;
    const zoneData = await findZones(lat, lng);
    let zoneId = zoneData[0].id;
    let zoneUpfrontAmount = zoneData[0].zoneMinimumAmount;
    let zoneSeviceCharge = zoneData[0].serviceCharge;
    let cityId = zoneData[0].city.id;
    let countryId = zoneData[0].city.country.id;
    return res.json(responsefunc("1", "Zone and Charges", { zoneId, zoneUpfrontAmount, zoneSeviceCharge, cityId, countryId }, ""));
}


/*
 *  Create Intent Using Stripe
 */
async function createIntentUsingStripe(req, res) {
    const { amount, customerId } = req.body;
    const intent = await createPaymentIntend(amount, customerId);
    console.log("🚀 ~ createIntentUsingStripe ~ intent:", intent)
    let intentData = {
        intentId: intent.id,
        clientSecret: intent.client_secret,
        amount: amount,
        customerId: customerId,
    }
    return res.json(responsefunc("1", "Intent Created", intentData, ""));
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
    deliveryTimeFrom
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
    createIntentUsingStripe
};

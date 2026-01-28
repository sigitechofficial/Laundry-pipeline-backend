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
    countries,
    cities,
    zone,
    cancelBooking,
    driverInZones,
    classifiedAs,
    roles,
    features,
    permissions,
    onHoldOption,
    agentSelectServices,
    bussinessInformation,
    bussinessWorkingHours,
    proofOfDeliveries,
    OnHoldConfirmation,
    machines,
    servicePreferences,
    serviceCategories,
    preferencesServiceName
} = require("../../models");
const sequelize = require("sequelize");
const { Op } = require("sequelize");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
var JSbarcode = require("jsbarcode");
const redisCli = require("../../redis/redis");
const otpGenerator = require("otp-generator");
const { 
    ValidationError, 
    NotFoundError, 
    ConflictError, 
    UnauthorizedError 
} = require('../../middlewares/universalErrorHandler');
const otpMail = require("../../helper/otpMail");
const error = require("../../middlewares/error");
const path = require("path");
const { stat, rmSync } = require("fs");
const stripe = require("../stripe");
const { create } = require("domain");
const { time } = require("console");
const { request } = require("http");
const checkServiceAvailability = require("../../utils/haversineFormula");
const { literal } = require("sequelize");
const getdistance = require("../../utils/distanceCalculator");
const { type } = require("os");
const { sendEvent } = require("../../socket_io");
const moment = require("moment");
const { map } = require("../../routes/driver");
const { resolveObjectURL } = require("buffer");
const { confirmAndCapturePayment, createPaymentIntend, createPaymentIntentForAgent } = require("../stripe");
const ResponseHelper = require('../../utils/responseHelper');
const { sendNotification } = require("../../utils/notification");
const customerPostcodeService = require('../../services/Customer/customerPostcodeService');
//!----------------------------------Agent Shop Address Add-----------------------------//
exports.agentAddressAdd = async (req, res) => {
    const {
        streetAddress,
        district,
        province,
        lat,
        lng,
        coordinates,
        addressType,
        userId,
        postalcode
    } = req.body;

    const findAgentShopAddress = await addressDb.findAll({
        where: {
            userId: userId,
        },
    });

    if (findAgentShopAddress.length > 0) {
        throw new ConflictError("Already Added the Shop Address");
    }

    const polygon = {
        type: "Polygon",
        coordinates: coordinates,
    };

    const fetchZones = await findZones(lat, lng);
    console.log("ðŸš€ ~ agentAddressAdd ~ fetchZones:", fetchZones[0].id);
    console.log("ðŸš€ ~ agentAddressAdd ~ fetchZones:", fetchZones[0].city.id);
    console.log(
        "ðŸš€ ~ agentAddressAdd ~ fetchZones:",
        fetchZones[0].city.country.id
    );

    // return res.json(fetchZones);

    const registerShop = await addressDb.create({
        streetAddress,
        district,
        cityId: fetchZones[0].city.id,
        province,
        countryId: fetchZones[0].city.country.id,
        lat,
        lng,
        status: true,
        postalcode,
        coordinates: polygon,
        userId: userId,
        zoneId: fetchZones[0].id,
        addressType,
    });

    return ResponseHelper.success(res, "Laundary Shhop Address Added", { registerShop });
}

//!----------------------------------Agent Shop Address Edit-----------------------------//
exports.agentAddressEdit = async (req, res) => {
    const {
        streetAddress,
        district,
        province,
        lat,
        lng,
        coordinates,
        addressType,
        addressId,
        postalcode
    } = req.body;

    console.log("req.body===================>>>", req.body)


    const agentId = req.user.id;

    // Check if address exists for this user
    const existingAddress = await addressDb.findOne({
        where: {
            addressType: "LaundaryShopAddress",
            userId: agentId,
        },
    });

    console.log("existingAddress===================>>>", existingAddress.id)


    if (!existingAddress) {
        throw new NotFoundError("No shop address found to edit. Please add an address first.");
    }

    const polygon = {
        type: "Polygon",
        coordinates: coordinates,
    };

    const fetchZones = await findZones(lat, lng);
    console.log("🚀 ~ agentAddressEdit ~ fetchZones:", fetchZones[0].id);
    console.log("🚀 ~ agentAddressEdit ~ fetchZones:", fetchZones[0].city.id);
    console.log(
        "🚀 ~ agentAddressEdit ~ fetchZones:",
        fetchZones[0].city.country.id
    );

    // Update the existing address
    const updatedAddress = await addressDb.update(
        {
            streetAddress,
            district,
            cityId: fetchZones[0].city.id,
            province,
            countryId: fetchZones[0].city.country.id,
            lat,
            lng,
            coordinates: polygon,
            zoneId: fetchZones[0].id,
            addressType,
            postalcode
        },
        {
            where: {
                id: existingAddress.id,
            },
        }
    );

    // Fetch the updated address to return in response
    const updatedAddressData = await addressDb.findByPk(existingAddress.id);

    console.log("updatedAddressData===================>>>", updatedAddressData)

    return ResponseHelper.success(res, "Laundry Shop Address Updated Successfully", updatedAddressData);
}

/*
 * Get Agent Address - Simple Version
 */
exports.getAgentAddress = async (req, res) => {
    const agentId = req.user.id;

    const agentAddress = await addressDb.findOne({
        where: {
            userId: agentId,
            addressType: "LaundaryShopAddress",
        },
        attributes: [
            "id",
            "streetAddress",
            "district",
            "province",
            "postalCode",
            "lat",
            "lng",
            "coordinates",
            "addressType",
            "zoneId",
            "cityId",
            "countryId",
            "status"
        ],
        include: [
            {
                model: countries,
                attributes: ["id", "name", "shortName"],
            },
            {
                model: cities,
                attributes: ["id", "name"],
            },
            {
                model: zone,
                attributes: ["id", "name", "zoneMinimumAmount", "serviceCharge"],
            },
        ],
    });

    if (!agentAddress) {
        throw new NotFoundError("No address found for this agent");
    }

    return ResponseHelper.success(res, "Agent Address Retrieved Successfully", agentAddress);
}

/*
 * Get Agent Address - Complex Version with Business Info
 */

exports.getShopAddress = async (req, res) => {
    const userId = req.user.id;

    const findAddress = await bussinessInformation.findOne({
        where: {
            agentId: userId,
        },
        attributes: ["id", "shopName", "matchProfileOptions", "agentId"],
        include: [
            {
                model: addressDb,
                where: {
                    addressType: "LaundaryShopAddress",
                    userId: userId,
                },
                attributes: [
                    "streetAddress",
                    "province",
                    "postalCode",
                    "district",
                    "lat",
                    "lng",
                    "coordinates",
                    "addressType",
                    "zoneId",
                ],
                include: [
                    {
                        model: countries,
                        attributes: ["name"],
                    },
                    {
                        model: cities,
                        attributes: ["name"],
                    },
                ],
            },
        ],
    });
    console.log("ðŸš€ ~ getShopAddress ~ findAddress:", findAddress.id);

    const workingHours = await bussinessWorkingHours.findAll({
        where: {
            bussinessInformationId: findAddress.id,
        },
        attributes: ["dayOfWeek", "openTime", "closeTime"],
    });

    let outObj = {
        findAddress,
        workingHours,
    };
    //console.log("ðŸš€ ~ getShopAddress ~ findAddress:", findAddress);
    return ResponseHelper.success(res, "Address Get", outObj);
}

//!------------------------------------------Get Order For Agent----------------------------------------//

/*
 * Get Agent Order Home Api
 */

exports.getBookingHome = async (req, res) => {
    const agentId = req.user.id;

    const userData = await users.findOne({
        where: {
            id: agentId,
        },
        include: [
            {
                model: addressDb,
                attributes: [
                    "id",
                    "streetAddress",
                    "zoneId",
                    "lat",
                    "lng",
                    "addressType",
                ],
            },
        ],
    });

    let agentZone = userData.addressDb.zoneId;
    console.log("ðŸš€ ~ getBookingHome ~ agentZone:", agentZone);
    const currentDate = new Date();
    currentDate.setSeconds(0, 0);
    const currentTimeString = currentDate.toTimeString().slice(0, 5);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const bookingData = await booking.findAll({
        where: {
            laundryShopId: null,
            bookingStatusId: 1,
            zoneId: agentZone,
            orderExpireTime: {
                [Op.gte]: currentTimeString
            },
            createdAt: {
                [Op.gte]: twentyFourHoursAgo
            }
        },
        include: [
            {
                model: addressDb,
                as: "pickupAddress",
                attributes: ["id", "streetAddress", "district", "province", "postalcode", "lat", "lng", "addressType"],
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName']
                    },
                    {
                        model: cities,
                        attributes: ['id', 'name']
                    }
                ]
            },
            {
                model: users,
                as: 'customer',
                attributes: ['id', 'firstName', 'lastName', 'email', 'userTypeId', 'image', 'phoneNum']
            },
            {
                model: zone,
                attributes: ['id', 'name', 'zoneMinimumAmount', 'serviceCharge', 'currencyUnitId']
            }
        ],
        attributes: ['id',
            'orderTrackId',
            'collectionDate',
            'collectionTimeTo',
            'collectionTimeFrom',
            'driverInstructionOptions',
            'driverInstructionOptions1',
            'driverInstruction',
            'paymentConfirmed',
            "partialPayment",
            "totalItems",
            "orderAmount",
            "frequency",
            "deliveryDate",
            "deliveryTimeFrom",
            "orderExpireTime",
            "deliveryTimeTo",
            "pickupAddresId",
            "dropOffAddressId",
            "laundryShopId",
            "customerId"
        ]
    });

    //return res.json(bookingData)


    return ResponseHelper.success(res, "Agent Orders fetched", { bookingData });
}

/*
 * Get ALl Order of Agent
 */
exports.getAgentOrder = async (req, res) => {
    const agentId = req.user.id;

    const getShopAddress = await addressDb.findOne({
        where: {
            userId: agentId,
            addressType: "LaundaryShopAddress",
        },
    });

    const getBooking = await booking.findAll({
        where: {
            bookingStatusId: 2,
            laundryShopId: getShopAddress.id,
        },
        include: [
            {
                model: users,
                as: "customer",
                attributes: [
                    "id",
                    "firstName",
                    "lastName",
                    "email",
                    "phoneNum",
                    "image",
                ],
                include: [
                    {
                        model: countries,
                        attributes: ["id", "name", "shortName"],
                    },
                    {
                        model: cities,
                        attributes: ["id", "name"],
                    },
                ],
            },
            {
                model: addressDb,
                as: "pickupAddress",
                attributes: [
                    "id",
                    "title",
                    "streetAddress",
                    "province",
                    "district",
                    "postalcode",
                    "lat",
                    "lng",
                ],
            },
            {
                model: addressDb,
                as: "dropOffAddress",
                attributes: [
                    "id",
                    "title",
                    "streetAddress",
                    "province",
                    "district",
                    "postalcode",
                    "lat",
                    "lng",
                ],
            },
        ],
        attributes: [
            "id",
            "collectionTimeTo",
            "collectionTimeFrom",
            "driverInstructionOptions",
            "driverInstructionOptions1",
            "driverInstruction",
            "totalItems",
            "bookingStatusId",
            "deliveryDate",
            "deliveryTimeFrom",
            "deliveryTimeTo",
            "laundryShopId",
            "customerId",
        ],
    });
    console.log("ðŸš€ ~ getAgentOrder ~ getBooking:", getBooking);

    //return res.json(getBooking);

    const outObj = {
        bookingData: getBooking.map((b) => ({
            id: b.id,
            collectionTimeTo: b.collectionTimeTo,
            collectionTimeFrom: b.collectionTimeFrom,
            driverInstructionOptions: b.driverInstructionOptions,
            driverInstructionOptions1: b.driverInstructionOptions1,
            driverInstruction: b.driverInstruction,
            totalItems: b.totalItems,
            bookingStatusId: b.bookingStatusId,
            deliveryDate: b.deliveryDate,
            deliveryTimeFrom: b.deliveryTimeFrom,
            deliveryTimeTo: b.deliveryTimeTo,
            laundryShopId: b.laundryShopId,
            customerId: b.customerId,
            customer: {
                id: b.customer?.id,
                firstName: b.customer?.firstName,
                lastName: b.customer?.lastName,
                email: b.customer?.email,
                phoneNum: b.customer?.phoneNum,
                image: b.customer?.image,
            },
            pickupAddress: b.pickupAddress
                ? {
                    id: b.pickupAddress.id,
                    title: b.pickupAddress.title,
                    streetAddress: b.pickupAddress.streetAddress,
                    province: b.pickupAddress.province,
                    district: b.pickupAddress.district,
                    postalcode: b.pickupAddress.postalcode,
                    lat: b.pickupAddress.lat,
                    lng: b.pickupAddress.lng,
                    country: b.customer?.country
                        ? {
                            id: b.customer.country.id,
                            name: b.customer.country.name,
                            shortName: b.customer.country.shortName,
                        }
                        : null,
                    city: b.customer?.city
                        ? {
                            id: b.customer.city.id,
                            name: b.customer.city.name,
                        }
                        : null,
                }
                : null,
            dropOffAddress: b.dropOffAddress
                ? {
                    id: b.dropOffAddress.id,
                    title: b.dropOffAddress.title,
                    streetAddress: b.dropOffAddress.streetAddress,
                    province: b.dropOffAddress.province,
                    district: b.dropOffAddress.district,
                    postalcode: b.dropOffAddress.postalcode,
                    lat: b.dropOffAddress.lat,
                    lng: b.dropOffAddress.lng,
                    country: b.customer?.country
                        ? {
                            id: b.customer.country.id,
                            name: b.customer.country.name,
                            shortName: b.customer.country.shortName,
                        }
                        : null,
                    city: b.customer?.city
                        ? {
                            id: b.customer.city.id,
                            name: b.customer.city.name,
                        }
                        : null,
                }
                : null,
        })),
    };

    return ResponseHelper.success(res, "Booking Available to Accept", outObj);
}

/*
 * Specific Order Details
 */
exports.orderDetailsById = async (req, res) => {
    const { bookingId, orderTrackId } = req.query;

    let whereCondition = {};

    if (bookingId) {
        whereCondition.id = bookingId;
    } else {
        whereCondition.orderTrackId = orderTrackId;
    }
    console.log("ðŸš€ ~ orderDetailsById ~ whereCondition:", whereCondition);

    const bookingfind = await booking.findOne({
        where: whereCondition,
        include: [
            {
                model: users,
                as: "customer",
                attributes: ["id", "firstName", "lastName", "email", "userTypeId"],
            },
            {
                model: bookingHistory,
                attributes: ["date", "time", "bookingStatusId"],
                include: [
                    {
                        model: bookingStatus,
                        attributes: ["title", "description"],
                    },
                ],
            },
            {
                model: addressDb,
                as: "pickupAddress",
                attributes: ["title", "streetAddress", "district", "province"],
            },
            {
                model: bookingStatus,
                attributes: ["title", "description"],
            },
        ],
    });

    if (bookingfind.bookingStatusId === 5) {
        const oneHourLater = moment().add(1, "hours").format("HH:mm A"); // 24-hour format with AM/PM
        return ResponseHelper.success(
            res,
            `Order Details for ${Object.keys(whereCondition)[0]}: ${Object.values(whereCondition)[0]}`,
            { bookingfind, oneHourLater }
        );
    }

    return ResponseHelper.success(
        res,
        `Order Details for ${Object.keys(whereCondition)[0]}: ${Object.values(whereCondition)[0]}`,
        bookingfind
    );
}

/*
 *  Agent booking Filters
 */

exports.agentBookingFilters = async (req, res) => {
    const agentId = req.user.id;

    const { filterType } = req.query

    const addressFound = await addressDb.findOne({
        where: { userId: agentId },
    });

    console.log("addressFound==========================>>", addressFound.id)

    if (!addressFound) {
        throw new NotFoundError("Address not found for agent");
    }

    const results = {};



    // Slot bookings
    if (filterType === 'slots') {
        results.slots = await getSlotBookings(addressFound.id);
        return ResponseHelper.success(res, "Booking Details Fetched for all filters", results);
    }


    // All bookings (any booking with this laundryShopId)
    results.All = await booking.findAll({
        where: {
            laundryShopId: addressFound.id,
            bookingStatusId: {
                [Op.notIn]: [1, 13, 17]
            }
        },
        attributes: [
            "id",
            "ordertrackId",
            "collectionTimeFrom",
            "collectiontimeTo",
            "collectionDate",
            "deliveryTimeFrom",
            "deliveryTimeTo",
            "deliveryDate",
            "driverInstructionOptions",
            "driverInstructionOptions1",
            "driverInstruction",
            "bookingStatusId"
        ],
        include: [
            {
                model: bookingStatus,
                attributes: ['id', 'title', 'description']
            }
            ,
            {
                model: addressDb,
                as: "laundryShop",
                attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName']
                    },
                    {
                        model: cities,
                        attributes: ['id', 'name']
                    }
                ]
            },
            {
                model: addressDb,
                as: "pickupAddress",
                attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName']
                    },
                    {
                        model: cities,
                        attributes: ['id', 'name']
                    }
                ]
            },
            {
                model: addressDb,
                as: "dropOffAddress",
                attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName']
                    },
                    {
                        model: cities,
                        attributes: ['id', 'name']
                    }
                ]
            },
            {
                model: users,
                as: "customer",
                attributes: ["firstName", "lastName", "email", "phoneNum"],
            },
        ],
    });

    return ResponseHelper.success(res, "Booking Details Fetched for all filters", results);
}




exports.invoiceDetailTab = async (req, res) => {
    const agentId = req.user.id;


    const addressFound = await addressDb.findOne({
        where: { userId: agentId },
    });

    if (!addressFound) {
        throw new NotFoundError("Address not found for agent");
    }

    const results = {};



    // All bookings (any booking with this laundryShopId)
    results.All = await booking.findAll({
        where: {
            laundryShopId: addressFound.id,
            bookingStatusId: 8
        },
        attributes: [
            "id",
            "ordertrackId",
            "collectionTimeFrom",
            "collectiontimeTo",
            "collectionDate",
            "deliveryTimeFrom",
            "deliveryTimeTo",
            "deliveryDate",
            "driverInstructionOptions",
            "driverInstructionOptions1",
            "driverInstruction",
            "bookingStatusId"
        ],
        include: [
            {
                model: bookingStatus,
                attributes: ['id', 'title', 'description']
            }
            ,
            {
                model: addressDb,
                as: "laundryShop",
                attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName']
                    },
                    {
                        model: cities,
                        attributes: ['id', 'name']
                    }
                ]
            },
            {
                model: addressDb,
                as: "pickupAddress",
                attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName']
                    },
                    {
                        model: cities,
                        attributes: ['id', 'name']
                    }
                ]
            },
            {
                model: addressDb,
                as: "dropOffAddress",
                attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName']
                    },
                    {
                        model: cities,
                        attributes: ['id', 'name']
                    }
                ]
            },
            {
                model: users,
                as: "customer",
                attributes: ["firstName", "lastName", "email", "phoneNum"],
            },
        ],
    });

    return ResponseHelper.success(res, "Booking Details Fetched for all filters", results);
}



/*
 *   Agent Booking status Update to one the way
 */
exports.agentBookingStatusOnTheWay = async (req, res) => {
    const { bookingId } = req.params;

    const bookingfind = await booking.findOne({
        where: { id: bookingId },
        include: [
            {
                model: users,
                as: 'customer',
                attributes: ['id', 'stripeCustomerId'],
            }
        ]
    });

    if (!bookingfind) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    if (bookingfind.bookingStatusId !== 3) {
        throw new NotFoundError("No driver is assigned to this booking yet");
    }

    // Validate required payment data
    if (!bookingfind.customer.stripeCustomerId) {
        throw new ValidationError("Stripe customer ID not found for this booking");
    }

    if (!bookingfind.paymentMethodId) {
        throw new ValidationError("Payment method not found. Setup Intent was not completed properly.");
    }

    const upfrontAmount = bookingfind.billingDetail?.upfrontAmount || 0;

    if (!upfrontAmount || upfrontAmount <= 0) {
        throw new ValidationError("Upfront amount not set for this booking");
    }

    console.log("💳 Creating payment intent for booking:", bookingId);
    console.log("💰 Upfront Amount:", upfrontAmount);
    console.log("👤 Customer:", bookingfind.customer.stripeCustomerId);
    console.log("💳 Payment Method (from Setup Intent):", bookingfind.paymentMethodId);
    console.log("🔑 Setup Intent ID:", bookingfind.setupIntentId);

    // Step 1: Create Payment Intent with the upfront amount
    const paymentIntent = await createPaymentIntend(upfrontAmount, bookingfind.customer.stripeCustomerId);
    console.log("✅ Payment Intent created:", paymentIntent.id);

    // Step 2: Confirm and Capture the payment using saved payment method
    const stripeResult = await confirmAndCapturePayment(
        paymentIntent.id,
        bookingfind.paymentMethodId,  // Using payment method saved at booking creation
        bookingfind.customer.stripeCustomerId
    );

    console.log("🚀 agentBookingStatusOnTheWay ~ stripeResult:", stripeResult);

    if (stripeResult.status !== 'succeeded') {
        throw new ValidationError(`Payment failed or incomplete. Current status: ${stripeResult.status}`);
    }

    console.log("✅ Payment captured successfully! Amount:", upfrontAmount);

    // Step 3: Update booking with payment intent ID and status
    // NOTE: paymentMethodId is already saved, we just add paymentIntentId
    await booking.update(
        { 
            bookingStatusId: 4,
            paymentIntentId: paymentIntent.id,
            paymentConfirmed: true
        },
        { where: { id: bookingId } }
    );

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];

    await bookingHistory.create({
        bookingId,
        date: currentDate,
        time: currentTime,
        bookingStatusId: 4,
    });

    const customerId=bookingfind.customerId;
    let title="Driver On The Way";
    let body="Your driver is on the way to the pickup location";
    let data={
        bookingId:bookingId,
        driverId:bookingfind.driverId,
    }
    sendNotification(customerId,title,body,data);

    return ResponseHelper.success(res, "Booking status updated and payment captured", {
        paymentIntentId: paymentIntent.id,
        paymentStatus: 'succeeded',
        amountCharged: upfrontAmount
    });
}

/*
 *   Agent Booking status Arrived
 */ 
exports.driverStatusArrived = async (req, res) => {
    const { bookingId } = req.params;

    const bookingfind = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (!bookingfind) {
        throw new NotFoundError(`Booking with this id: ${bookingId} not exists`);
    }

    if (bookingfind.bookingStatusId !== 4) {
        throw new ValidationError("Your driver is still not out for pickup");
    }

    await booking.update(
        {
            bookingStatusId: 5,
        },
        { where: { id: bookingId } }
    );

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingStatusId: 5,
        bookingId: bookingId,
    });

    const customerId=bookingfind.customerId;
    let title="Driver Arrived";
    let body="Your driver has arrived at the pickup location";
    let data={
        bookingId:bookingId,
        driverId:bookingfind.driverId,
    }
    sendNotification(customerId,title,body,data);
    return ResponseHelper.success(res, "Booking Status Updated to Driver Arrived", {});
}

/*
 *   Driver/Agent Add pictures of pickup and delivery
 */
exports.AddPickupDeliveryProof = async (req, res) => {
    const { noOfItems, note, bookingId, deliveryType } = req.body;
    console.log("ðŸš€ ~ AddPickupDeliveryProof ~ req.body:", req.body);
    const userId = req.user.id;

    if (!req.files.length) {
        throw new ValidationError("Proof Images are not uploaded. Please Upload the Images");
    }

    let imgArr = req.files.map((ele) => {
        let tmpPath = ele.path;
        let imagePath = tmpPath.replace(/\\/g, "/");
        return {
            imgUpload: imagePath,
            userId,
            bookingId,
            noOfItems,
            note,
            deliveryType
        };
    });

    await proofOfDeliveries.bulkCreate(imgArr);

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];

    await booking.update(
        {
            totalitems: noOfItems,
        },
        {
            where: { id: bookingId },
        }
    );

    return ResponseHelper.success(res, "Driver proof Pics Uploaded Successfully", {});
}

/*
 *   Agent PickingUp and Inspection Status Update
 */

exports.agentInspectionStatus = async (req, res) => {
    const { bookingId } = req.params;

    const bookingFind = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingFind.bookingStatusId !== 5) {
        throw new ValidationError("Your driver is not reached yet");
    }

    await booking.update(
        {
            bookingStatusId: 7,
        },
        { where: { id: bookingId } }
    );

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];

    const statusId = [6, 7];
    const bookinghistories = statusId.map(statusId => ({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: statusId
    }))
    await bookingHistory.bulkCreate(bookinghistories);

    const customerId=bookingFind.customerId;
    let title="Driver Picked Up";
    let body="Your driver has picked up your laundry";
    let data={
        bookingId:bookingId,
        driverId:bookingFind.driverId,
    }
    sendNotification(customerId,title,body,data);

    return ResponseHelper.success(res, "Booking PickingUp and Inspection Status Updated", {});
}

/*
 *   Agent/Driver Reached to the Delivery Shop Status Update
 */
exports.reachedAtDeliveryShopStatus = async (req, res) => {
    const { bookingId } = req.params;

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingCheck.bookingStatusId !== 7) {
        throw new ValidationError("Booking is still not In Transit to Facility");
    }

    await booking.update(
        {
            bookingStatusId: 8,
        },
        { where: { id: bookingId } }
    );

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];


    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: 8,
    });

    const customerId=bookingCheck.customerId;
    let title="Driver Reached At Laundry Shop";
    let body="Your driver has reached at the laundry shop";
    let data={
        bookingId:bookingId,
        driverId:bookingCheck.driverId,
    }
    sendNotification(customerId,title,body,data);

    return ResponseHelper.success(res, "Driver Reached At Laundry Shop", {});
}


/*
 *  Create Intent Using Stripe
 */
exports.createIntentUsingStripeForAgent = async (req, res) => {
    const { amount, customerId, savedPaymentMethodId } = req.body;
    console.log("Amount ------------------------>", amount)
    const intent = await createPaymentIntentForAgent(amount, customerId, savedPaymentMethodId);
    console.log("🚀 ~ createIntentUsingStripe ~ intent:", intent)
    let intentData = {
        intentId: intent.id,
        amount: intent.amount,
        customerId: customerId,
    }
    return ResponseHelper.success(res, "Intent Created", {});
}



/*
 *   Laundry Status Updated Invoice Generated and Status goes to In-Procesing
 */
exports.bookingInvoiceGeneratedStatusUpdated = async (req, res) => {
    const { bookingId } = req.params;

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingCheck.bookingStatusId !== 9) {
        throw new ValidationError("Booking is still not In Transit to Facility");
    }

    await booking.update(
        {
            bookingStatusId: 11,
            paymentConfirmed: true,
        },
        { where: { id: bookingId } }
    );

    await billingDetails.update(
        {
            paymentStatus: "Paid",
        },
        { where: { bookingId: bookingId } }
    );

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];


    const statusId = [10, 11];
    const bookinghistories = statusId.map(statusId => ({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: statusId
    }))
    await bookingHistory.bulkCreate(bookinghistories);

    const customerId=bookingCheck.customerId;
    let title="Laundry Invoice Generated";
    let body="Your laundry invoice has been generated";
    let data={
        bookingId:bookingId,
        driverId:bookingCheck.driverId,
    }
    sendNotification(customerId,title,body,data);

    return ResponseHelper.success(res, "Driver Reached At Laundry Shop", {});
}


/*
 *   Laundry Status Updated That laundry is Washed
 */
exports.laundryWashCompleted = async (req, res) => {
    const { bookingId } = req.params;


    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingCheck.bookingStatusId !== 11) {
        throw new ValidationError("Booking is still not In Processing or Invoice Not Generated");
    }

    await booking.update(
        {
            bookingStatusId: 12,
        },
        { where: { id: bookingId } }
    );

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingStatusId: 12,
        bookingId: bookingId,
    });
    const customerId=bookingCheck.customerId;
    let title="Laundry Has Been Washed At Shop";
    let body="Your laundry has been washed at the shop";
    let data={
        bookingId:bookingId,
        driverId:bookingCheck.driverId,
    }
    sendNotification(customerId,title,body,data);
    return ResponseHelper.success(res, "Laundry Has Been Washed At Shop", {});
}

/*
 *   Laundry Status Updated That Laundry is Out for Delivery to Customer
 */
exports.laundryDeliverToCustomer = async (req, res) => {
    const { bookingId } = req.params;

    const driverId = req.query.driverId;

    const agentId = req.user.id;

    if (driverId) {
        await booking.update(
            {
                bookingStatusId: 13,
                deliveryDriverId: driverId,
            },
            { where: { id: bookingId } }
        );
    } else {
        await booking.update(
            {
                bookingStatusId: 13,
                driverId: agentId,
            },
            { where: { id: bookingId } }
        );
    }

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: 13,
    });

    // const customerId=bookingCheck.customerId;
    // let title="Driver Out for Deliver Laundry to Customer";
    // let body="Your driver is out for deliver laundry to customer";
    // let data={
    //     bookingId:bookingId,
    //     driverId:bookingCheck.driverId,
    // }
    // sendNotification(customerId,title,body,data);

    return ResponseHelper.success(res, "Driver updated and out for Deliver Laundry to Customer", {});
}

/*
 *   Driver Reached at customer Destination
 */
exports.driverReachedForDelivery = async (req, res) => {
    const { bookingId } = req.params;

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingCheck.bookingStatusId !== 13) {
        throw new ValidationError("Driver is not out to deliver your laundry");
    }

    await booking.update(
        {
            bookingStatusId: 14,
        },
        { where: { id: bookingId } }
    );

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: 14,
    });

    const customerId=bookingCheck.customerId;
    let title="Driver Reached at Customer Destination";
    let body="Your driver has reached at the customer destination";
    let data={
        bookingId:bookingId,
        driverId:bookingCheck.driverId,
    }
    sendNotification(customerId,title,body,data);

    return ResponseHelper.success(res, "Driver reached for delivery", {});
}

/*
 *   Booking Deliver to Customer (Delivery)
 */
exports.bookingDeliverToCustomer = async (req, res) => {
    const { bookingId } = req.params;

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingCheck.bookingStatusId !== 14) {
        throw new ValidationError("Driver not reached yet at customer destination");
    }

    await booking.update(
        {
            bookingStatusId: 17,
        },
        { where: { id: bookingId } }
    );

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];

    const statusId = [16, 17];
    const bookinghistories = statusId.map(statusId => ({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: statusId
    }))
    await bookingHistory.bulkCreate(bookinghistories);

    const customerId=bookingCheck.customerId;
    let title="Laundry Delivered to Customer";
    let body="Your laundry has been delivered to customer";
    let data={
        bookingId:bookingId,
        driverId:bookingCheck.driverId,
    }
    sendNotification(customerId,title,body,data);


    return ResponseHelper.success(res, "Laundry Delivered to customer sucessfully", {});
}

//!-----------------------------Booking Step-2 When Agent/Driver Added the Services------------------------//

/*
 * Agent Add Services At the time of Invoice
 */

exports.driverAddSerivces = async (req, res) => {
    const { services, bookingId, zoneMinimumAmount, serviceCharge } = req.body;

    if (!Array.isArray(services) || services.length === 0) {
        throw new ValidationError("Invalid request. Please provide an array of services.");
    }

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];
    console.log("Current Date:", currentDate);

    // Fetch booking with zone information
    const bookings = await booking.findByPk(bookingId, {
        include: [
            {
                model: zone,
                attributes: ['id', 'name', 'zoneAdminComission']
            }
        ]
    });

    if (!bookings) {
        throw new NotFoundError("Booking not found");
    }

    // Get zone information directly from booking
    const zoneData = bookings.zone;
    if (!zoneData) {
        throw new NotFoundError("Zone information not found for this booking");
    }

    let total = 0;

    if (services.length > 0) {
        for (let service of services) {
            const itemTotalPrice = parseFloat(service.categoryCharge || 0);
            total += itemTotalPrice;

            const existingRecords = await customerSelectedService.findAll({
                where: {
                    bookingId,
                    serviceId: service.serviceId,
                    subCategoryId: { [Op.is]: null },
                    categoryId: { [Op.is]: null },
                }
            });

            let matched = existingRecords.find(r => r.subCategoryId === service.subCategoryId);

            // 👇 fallback: update the first one with null subCategoryId
            if (!matched) {
                matched = existingRecords.find(r => r.subCategoryId === null);
            }

            if (matched) {
                console.log(`✅ Updating existing record (id ${matched.id})`);
                await matched.update({
                    categoryId: service.categoryId,
                    categoryPrice: itemTotalPrice,
                    subCategoryId: service.subCategoryId,
                    items: service.items,
                    date: currentDate,
                    time: currentTime,
                    status: true
                });
            } else {
                console.log(`🆕 Creating new for subCategoryId: ${service.subCategoryId}`);
                await customerSelectedService.create({
                    date: currentDate,
                    time: currentTime,
                    bookingId: bookingId,
                    serviceId: service.serviceId,
                    categoryId: service.categoryId,
                    categoryPrice: itemTotalPrice,
                    subCategoryId: service.subCategoryId,
                    items: service.items,
                    status: true
                });
            }
        }
    }

    const parsedServiceCharge = parseFloat(serviceCharge) || 0;
    const parsedZoneMinimum = parseFloat(zoneMinimumAmount) || 0;

    let subTotal = total;
    console.log("Sub-Total------->>>", subTotal);

    total += parsedServiceCharge;
    console.log("Total Before Zone Deduction:", total);

    total -= parsedZoneMinimum;

    // Calculate zone admin commission
    const zoneAdminCommission = parseFloat(zoneData.zoneAdminComission || 20);
    const zoneAdminCommissionAmount = (subTotal * zoneAdminCommission) / 100;
    
    console.log("Zone Admin Commission %%%%%%%%%%%%%%%%%%%%%%%%%%:", zoneAdminCommission);
    console.log("Zone Admin Commission Amount%%%%%%%%%%%%%%%%%%%%%:", zoneAdminCommissionAmount);

    // Round to 2 decimal places
    total = parseFloat(total.toFixed(2));
    subTotal = parseFloat(subTotal.toFixed(2));
    const finalZoneAdminCommissionAmount = parseFloat(zoneAdminCommissionAmount.toFixed(2));

    console.log("Final Total After Zone Deduction:", total);

    if (isNaN(total)) {
        throw new Error("Calculated total is NaN. Please check your input values.");
    }

    await billingDetails.update(
        {
            total,
            discount: 0,
            paymentStatus: "Pending",
            zoneAdminCommission: finalZoneAdminCommissionAmount, // Store zone admin commission
        },
        { where: { bookingId: bookingId } }
    );

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: 9,
    });

    await booking.update(
        {
            orderAmount: total,
            bookingStatusId: 9,
            subTotal,
        },
        { where: { id: bookingId } }
    );

    const customerId = bookings.customerId;
    let title = "Agent/Driver Added Detail";
    let body = "Your agent/driver has added detail";
    let data = {
        bookingId: bookingId,
        driverId: bookings.driverId,
    }
    sendNotification(customerId, title, body, data);

    return ResponseHelper.success(res, "Agent/Driver Added Detail", {});
}


/*
 *  Agent Update Invoice
 */
exports.agentUpdateInvoice = async (req, res) => {
    const { bookingId, total, services } = req.body

    console.log("Req.body--------------------->", req.body)

    const bookings = await booking.findByPk(bookingId);
    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];
    console.log("Current Date:", currentDate);

    if (!bookings) {
        return res.status(404).json({
            status: "0",
            message: "Booking not found",
            data: {},
            error: "Booking not found"
        });
    }

    for (let service of services) {
        const { categoryId, serviceId, subCategoryId } = service;


        const updatedService = await customerSelectedService.update(
            {
                status: false
            },
            {
                where: {
                    serviceId: serviceId,
                    bookingId: bookingId,
                    subCategoryId: subCategoryId

                }
            }
        );

        await booking.update({
            orderAmount: total,
            bookingStatusId: 22
        }, { where: { id: bookingId } })

        await bookingHistory.create({
            date: currentDate,
            time: currentTime,
            bookingId: bookingId,
            bookingStatusId: 22,
        });

        await OnHoldConfirmation.update(
            {
                deleted: true
            },
            {
                where: {
                    serviceId: serviceId,
                    bookingId: bookingId,
                    subCategoryId: subCategoryId

                }
            }
        )

        await billingDetails.update(
            {
                total,
                discount: 0,
                paymentStatus: "Pending",
            },
            { where: { bookingId: bookingId } }
        );





        // if (updatedService[0] === 0) {
        //     return res.status(400).json({
        //         status: "0",
        //         message: "Service update failed",
        //         data: {},
        //         error: "No matching service found or no updates were made"
        //     });
        // }


    }
    const customerId=bookings.customerId;
    let title="Agent/Driver Updated Invoice";
    let body="Your agent/driver has updated invoice";
    let data={
        bookingId:bookingId,
        driverId:bookings.driverId,
    }
    sendNotification(customerId,title,body,data);


    return res.status(200).json({
        status: "1",
        message: "Booking services updated successfully",
        data: booking,
        error: ""
    });

}

/*
 *  Invoice Creation
 */
exports.invoiceCreation = async (req, res) => {
    const bookingId = req.params.bookingId;
    console.log("bookingId", bookingId);

    const invoiceDetails = await booking.findAll({
        where: { id: bookingId },
        include: [
            {
                model: zone,
                attributes: ['id', 'name', 'zoneMinimumAmount', 'serviceCharge']
            },
            {
                model: users,
                as: "customer",
                attributes: ["firstName", "lastName", "email", "phoneNum", "image", "stripeCustomerId"]
            },
            {
                model: addressDb,
                as: "pickupAddress",
                attributes: [
                    "title", "streetAddress", "district", "province", "postalcode", "addressType"
                ],
                include: [
                    { model: countries, attributes: ["name", "shortName"] },
                    { model: cities, attributes: ['id', "name"] }
                ]
            },
            {
                model: addressDb,
                as: "dropOffAddress",
                attributes: [
                    "title", "streetAddress", "district", "province", "postalcode", "addressType"
                ],
                include: [
                    { model: countries, attributes: ["name", "shortName"] },
                    { model: cities, attributes: ['id', "name"] }
                ]
            },
            {
                model: customerSelectedService,
                required: false,
                include: [
                    {
                        model: service,
                        required: false,
                        attributes: { exclude: ["createdAt", "updatedAt", "timeRequired"] },
                        include: [
                            {
                                model: servicePreferences,
                                required: false,
                                where: { bookingId: bookingId },
                                attributes: [
                                    'id', 'type', 'chooseTemperature', 'numberOfBags', 'preferencesServiceNameId', 'serviceId'
                                ],
                                include: [
                                    {
                                        model: preferencesServiceName,
                                        attributes: ['id', 'title']
                                    }
                                ]
                            }
                        ]
                    },
                    {
                        model: categories,
                        required: false,
                        attributes: { exclude: ["createdAt", "updatedAt", "serviceId"] }
                    },
                    {
                        model: subCategories,
                        required: false,
                        attributes: { exclude: ["createdAt", "updatedAt"] }
                    }
                ],
                attributes: [
                    "id", "date", "time", "categoryPrice", "bookingId",
                    "categoryId", "serviceId", "subCategoryId", "items"
                ]
            },
            {
                model: OnHoldConfirmation,
                required: false,
                attributes: ["id", "description", "serviceId", "subCategoryId", "bookingId", "onHoldImg", "customerResponse"]
            },
            {
                model: billingDetails,
                required: false,
                attributes: ["upfrontAmount", "total", "paymentStatus"]
            },
            {
                model: bookingStatus,
                attributes: ["title", "description"]
            },
            {
                model: proofOfDeliveries,
                attributes: ['id', 'imgUpload', 'noOfItems', 'note', 'deliveryType', 'bookingId', 'userId']
            }
        ],
        attributes: { exclude: ["categoryId", "serviceId", "subCategoryId"] }
    });


    // Handle no results case
    if (!invoiceDetails || invoiceDetails.length === 0) {
        throw new NotFoundError("No invoice data found");
    }

    // Time calculations (1 hour ahead in Karachi)
    const nowInKarachi = new Date().toLocaleString("en-US", { timeZone: "Asia/Karachi" });
    const currentKarachiTime = new Date(nowInKarachi);
    const futureTime = new Date(currentKarachiTime.getTime() + 60 * 60 * 1000); // +1 hour
    const remainingTime = Math.floor((futureTime - currentKarachiTime) / 60000); // ~60 min

    // Flatten invoiceDetails and deduplicate servicePreferences
    const bookingData = invoiceDetails[0]?.toJSON();
    const seenServiceIds = new Set();

    bookingData.customerSelectedServices = bookingData.customerSelectedServices.map(item => {
        if (!item.service) return item;

        const serviceId = item.service.id;

        if (seenServiceIds.has(serviceId)) {
            return {
                ...item,
                service: {
                    ...item.service,
                    servicePreferences: []
                }
            };
        }

        seenServiceIds.add(serviceId);
        return item;
    });

    return ResponseHelper.success(res, "Invoice Details", {
        invoiceDetails: bookingData,
        remainingTime
    });
}



/*
 * Customer Selected Sevices && Items
 */
// async function customerServices(req, res) {
//     const { bookingId } = req.query;

//     const customerServicesFind = await customerSelectedService.findAll({
//         where: {
//             bookingId: bookingId,
//         },
//         include: [
//             {
//                 model: service,
//                 attributes: ["id", "name"],
//                 include: [
//                     {
//                         model: servicePreferences,
//                         required: false,
//                         where: {
//                             bookingId: bookingId
//                         },
//                         attributes: ['id', 'type', 'chooseTemperature', 'numberOfBags', 'preferencesServiceNameId', 'serviceId']
//                     }
//                 ]
//             },
//             {
//                 model: categories,
//                 attributes: ["id", "name"],
//             },
//             {
//                 model: subCategories,
//                 attributes: ["id", "name", "price"],
//             },
//         ],
//         attributes: ['categoryPrice', 'items']
//     });

//     console.log(
//         "ðŸš€ ~ customerServices ~ customerServicesFind:",
//         customerServicesFind
//     );


//     const groupedServices = customerServicesFind.reduce((acc, item) => {
//         const serviceName = item.service.name;


//         if (!acc[serviceName]) {
//             acc[serviceName] = {
//                 serviceName,
//                 serviceId: item.service.id,
//                 servicePreferences: item.service.servicePreferences || [],
//                 categories: []
//             };
//         }


//         const existingCategoryIndex = acc[serviceName].categories.findIndex(
//             category => category.name === item.category.name
//         );


//         if (existingCategoryIndex === -1) {
//             acc[serviceName].categories.push({
//                 id: item.category.id,
//                 name: item.category.name,
//                 subCategories: [
//                     {
//                         id: item.subCategory.id,
//                         name: item.subCategory.name,
//                         price: item.subCategory.price
//                     }
//                 ]
//             });
//         } else {

//             acc[serviceName].categories[existingCategoryIndex].subCategories.push({
//                 id: item.subCategory.id,
//                 name: item.subCategory.name,
//                 price: item.subCategory.price
//             });
//         }

//         return acc;
//     }, {});


//     const formattedResponse = Object.values(groupedServices);

//     return res.json(
//         responsefunc(
//             "1",
//             "Customer Selected Services",
//             { customerServices: formattedResponse },
//             ""
//         )
//     );
// }
exports.customerServices = async (req, res) => {
    const { bookingId } = req.query;

    const customerServicesFind = await customerSelectedService.findAll({
        where: {
            bookingId: bookingId,
            status: true
        },
        include: [
            {
                model: service,
                attributes: ["id", "name"],
                include: [
                    {
                        model: servicePreferences,
                        required: false,
                        where: {
                            bookingId: bookingId
                        },
                        attributes: ['id', 'type', 'chooseTemperature', 'numberOfBags', 'preferencesServiceNameId', 'serviceId']
                    }
                ]
            },
            {
                model: categories,
                attributes: ["id", "name"],
            },
            {
                model: subCategories,
                attributes: ["id", "name", "price"],
            },
        ],
        attributes: ['id', 'categoryPrice', 'items']
    });

    if (!customerServicesFind || customerServicesFind.length === 0) {
        return ResponseHelper.success(res, "No Customer Selected Services", {
            customerServices: [],
            totalAmount: 0
        });
    }

    // Calculate total
    const totalAmount = customerServicesFind.reduce((sum, item) => {
        const price = parseFloat(item.categoryPrice) || 0;
        return sum + price;
    }, 0);

    const groupedServices = customerServicesFind.reduce((acc, item) => {
        if (!item.service || !item.category || !item.subCategory) return acc;

        const serviceName = item.service.name;

        if (!acc[serviceName]) {
            acc[serviceName] = {
                serviceName,
                serviceId: item.service.id,
                servicePreferences: item.service.servicePreferences || [],
                categories: []
            };
        }

        const existingCategoryIndex = acc[serviceName].categories.findIndex(
            category => category.name === item.category.name
        );

        const subCategory = {
            id: item.subCategory.id,
            name: item.subCategory.name,
            price: item.subCategory.price,
            recordId: item.id
        };

        if (existingCategoryIndex === -1) {
            acc[serviceName].categories.push({
                id: item.category.id,
                name: item.category.name,
                subCategories: [subCategory]
            });
        } else {
            acc[serviceName].categories[existingCategoryIndex].subCategories.push(subCategory);
        }

        return acc;
    }, {});

    const formattedResponse = Object.values(groupedServices);

    return ResponseHelper.success(res, "Customer Selected Services", {
        customerServices: formattedResponse,
        totalAmount
    });
}


/*
 * on Hold Conformation
 */
exports.onHoldConformation = async (req, res) => {
    let records = [];

    // Parse incoming records safely
    if (!req.body.records) {
        throw new Error("Missing 'records' in request body.");
    }
    records = JSON.parse(req.body.records);
    console.log("records===============================>>>>>>>>", records);


    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];
    console.log("Current Date:", currentDate);

    const responseData = [];

    for (let i = 0; i < records.length; i++) {
        const { serviceId, subCategoryId, bookingId, noOfItems, description } = records[i];

        // Match the uploaded image by index, not from records[i].onHoldImg
        let onHoldImg = "";
        if (req.files?.onHoldImg?.[i]) {
            console.log("Images get ==========================================>>>>")
            onHoldImg = req.files.onHoldImg[i].path.replace(/\\/g, "/");
        }

        console.log("onHoldImg for record", i, "==>", onHoldImg);

        // Store in DB
        const createConformation = await OnHoldConfirmation.create({
            serviceId,
            subCategoryId,
            bookingId,
            noOfItems,
            description,
            onHoldImg,
        });

        console.log("createConformation record #", i, ":", createConformation?.dataValues);

        await booking.update(
            { bookingStatusId: 18 },
            { where: { id: bookingId } }
        );

        await bookingHistory.create({
            date: currentDate,
            time: currentTime,
            bookingId,
            bookingStatusId: 18,
        });

        responseData.push({
            message: "Hold Confirmation Submitted",
            record: createConformation,
        });
    }

    return ResponseHelper.success(res, "Hold Confirmation Submitted for All Records", { responseData });
}

/*
 * Get Those Services Items Those Are Rejected 
 */
exports.rejectedServiceItems = async (req, res) => {
    const { bookingId } = req.params


    const rejectedItems = await OnHoldConfirmation.findAll({
        where: {
            bookingId: bookingId,
        },
        include: [
            {
                model: service,
                attributes: ['id', 'name']
            },
            {
                model: subCategories,
                attributes: ['id', 'name', 'price']
            }
        ],
        attributes: ['id', 'noOfItems', 'description', 'serviceId', 'subCategoryId', 'customerResponse', 'deleted']
    })

    console.log("rejectedItems======================....", rejectedItems[0].customerResponse)

    if (rejectedItems[0].customerResponse === true && rejectedItems[0].deleted === true) {
        return ResponseHelper.success(res, "Rejected Services Items", {})
    }


    return ResponseHelper.success(res, "Rejected Services Items", { rejectedItems })

}


/*
 * Agent Update Status To issue resoved
 */
exports.agentIssueResolved = async (req, res) => {
    const { bookingId } = req.params;

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingCheck.bookingStatusId !== 22) {
        throw new ValidationError("Booking customer Response is not confirmed");
    }

    await booking.update(
        {
            bookingStatusId: 11,
        },
        { where: { id: bookingId } }
    );

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];

    const statusId = [11, 19];
    const bookinghistories = statusId.map(statusId => ({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: statusId
    }))
    await bookingHistory.bulkCreate(bookinghistories);

    return ResponseHelper.success(res, "Booking Status Updated Issue Resolved", {});
}

//!-------------------------Agent Drivers-------------------------------//
/*
 *     All Agent Laundry Drivers
 */
exports.agnetDrivers = async (req, res) => {
    const agentId = req.user.id;

    const laundryShopFound = await bussinessInformation.findOne({
        where: {
            agentId: agentId,
        },
    });
    console.log("ðŸš€ ~ agnetDrivers ~ laundryShopFound:", laundryShopFound);
    //return res.json(laundryShopFound)
    const driverFound = await driverInZones.findAll({
        where: {
            laundaryShopId: 1,
        },
        include: [
            {
                model: users,
                as: "driverInZone",
                where: {
                    classifiedAsId: 1,
                    roleId: 6,
                },
                attributes: ["id", "firstName", "lastName", "email"],
            },
            {
                model: bussinessInformation,
                as: "laundaryDriver",
                attributes: ["shopAddressId"],
                include: [
                    {
                        model: addressDb,
                        where: {
                            addressType: "LaundaryShopAddress",
                        },
                        attributes: [
                            "streetAddress",
                            "province",
                            "lat",
                            "lng",
                            "addressType",
                        ],
                    },
                ],
            },
        ],
        attributes: ["id", "status", "cityId", "countryId", "zoneId"],
    });
    console.log("ðŸš€ ~ agnetDrivers ~ driverFound:", driverFound);
    return res.json(
        responsefunc(
            "1",
            "All Drivers Fetched for this Laundry Shop",
            driverFound,
            " "
        )
    );
}

/*
 *     Agent Assign Booking To Laundry Driver
 */
exports.agentAssignBookingToLaundryDriver = async (req, res) => {
    const { driverId, bookingId } = req.body;

    const orderAssign = await booking.update(
        {
            driverId: driverId,
            bookingStatusId: 13,
        },
        {
            where: {
                id: bookingId,
            },
        }
    );

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];
    console.log(currentDate); // Example: "2025-01-28"

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: 13,
    });
    return ResponseHelper.success(res, "Order Assign to Laundry Driver", {});
}

/*
 * Agent pickup order BySelf
 */
exports.agentPickupOrderBySelf = async (req, res) => {
    const agentId = req.user.id;
    const { bookingId } = req.query.bookingId;

    const agentByselfPickup = await bookingHistory.update(
        {
            bookingStatusId: 13,
            driverId: agentId,
        },
        {
            where: {
                id: bookingId,
            },
        }
    );

    const currentDate = new Date.toISOString().split("T")[0];
    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: 13,
    });

    return ResponseHelper.success(res, "Agent Assigned To PickUp Order", {});
}

//!-----------------------------------Agent Cancel Booking------------------------------------//
exports.agentCancelBooking = async (req, res) => {
    const { bookingId, reasonId, reasonText } = req.body;

    const getBookingData = await booking.findOne({
        where: {
            id: bookingId,
        },
    });
    console.log("ðŸš€ ~ agentCancelBooking ~ getBookingData:", getBookingData);

    const cancelBookingData = await cancelBooking.create({
        bookingId: bookingId,
        reasonId: reasonId,
        reasonText: reasonText,
    });

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    const currentDate = new Date().toISOString().split("T")[0];

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: 13,
        reasonId: reasonId,
    });

    await booking.update(
        {
            bookingStatusId: 13,
        },
        { where: { id: bookingId } }
    );

    return ResponseHelper.success(res, "Booking Cancelled Sucessfully", {});
}

//!------------------------Admin Create Roles,Classicifations,Permissions-------------------------//

/*
 * Add Roles
 */

exports.addRole = async (req, res) => {
    const { name, permissionRole } = req.body;

    const checkExist = await roles.findOne({ where: { name } });
    if (checkExist) {
        throw new ConflictError("Same role exists. Please try another name");
    }
    const newRole = await roles.create({ name, status: true });

    let bulkArray = permissionRole.map((ele) => ({
        featureId: ele.id,
        roleId: newRole.id,
        read: ele.permissions.read || false,
        write: ele.permissions.write || false
    }));

    await permissions.bulkCreate(bulkArray);

    return ResponseHelper.success(res, "Role and Permission Added Successfully", {});
}

/*
 * Update Roles
 */
exports.updateRoles = async (req, res) => {
    const { name, permissionRole, roleId } = req.body;

    if (!roleId) {
        throw new ValidationError("Missing role ID. Role ID is required to update role");
    }

    if (name) {
        const checkExist = await roles.findOne({
            where: { name, id: { [Op.not]: roleId } },
        });

        if (checkExist) {
            throw new ConflictError("Same role exists. Please try another name");
        }
    }

    const updatePayload = {};
    if (name) updatePayload.name = name;
    updatePayload.status = true;

    await roles.update(updatePayload, { where: { id: roleId } });

    if (Array.isArray(permissionRole) && permissionRole.length > 0) {
        await permissions.destroy({ where: { roleId } });

        const bulkArray = permissionRole.map((ele) => ({
            featureId: ele.id,
            roleId,
            read: ele.permissions?.read || false,
            write: ele.permissions?.write || false,
        }));

        await permissions.bulkCreate(bulkArray);
    }



    return ResponseHelper.success(res, "Role updated successfully", {});
}

/*
 * Get All Roles
 */
exports.getAllRoles = async (req, res) => {
    const getRoles = await roles.findAll({
        where: {
            status: true,
        },
        attributes: ["id", "name", "status"],
    });

    return ResponseHelper.success(res, "Get All Roles", { getRoles });
}


/*
 * Get Permissions
 */
exports.getPermissions = async (req, res) => {
    const roleId = req.query.roleId;
    const getPermissions = await permissions.findAll({
        where: {
            roleId: roleId
        },
        include: [
            {
                model: features,
                attributes: ['id', 'title', 'status']
            },
            {
                model: roles,
                attributes: ['id', 'name', 'status']
            },
        ],
        attributes: ['id', 'read', 'write', 'featureId', 'roleId']
    });
    return ResponseHelper.success(res, "Get All Permissions", { getPermissions });
}


/*
 * Add Classified
 */
exports.addClassifiedAs = async (req, res) => {
    const { name } = req.body;
    const createData = await classifiedAs.create({
        name,
    });
    return ResponseHelper.success(res, "Added the classified As", createData);
}

/*
 * Get ClassifiedAs
 */
exports.getClassifiedAs = async (req, res) => {
    const findData = await classifiedAs.findAll({
        attributes: ["id", "name"],
    });

    return ResponseHelper.success(res, "Fetched All ClassifiedAs Roles", findData);
}

/*
 * Add Features
 */
exports.addfeatures = async (req, res) => {
    const { title, status, featureOf, key } = req.body;

    const titleFound = await features.findOne({
        where: {
            title: title,
            key: key,
        },
    });

    if (titleFound) {
        throw new ConflictError("Feature Already Exists");
    }

    const createFeatures = await features.create({
        title,
        status,
        featureOf,
        key,
    });
    return ResponseHelper.success(res, "Feature Added", { createFeatures });
}

/*
 * Get Features
 */
exports.getFeatures = async (req, res) => {
    const findFeature = await features.findAll({
        where: {
            status: true,
        },
        attributes: ["id", "title", "status"],
    });

    return ResponseHelper.success(res, "All Features Fetched", { findFeature });
}

//!------------------------------Agent Add Employees--------------------------//
/*
 * Add Employee
 */

exports.addEmployee = async (req, res) => {
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

    const userFind = await users.findOne({
        where: {
            classifiedAsId: 1,
            roleId: roleId,
            firstName: firstName,
            lastName: lastName,
            email
        },
    });

    if (userFind) {
        throw new ConflictError("Employee Already Exists");
    }

    let hashpassword = await bcrypt.hash(password, 10);

    const user = await users.create({
        firstName,
        lastName,
        email,
        password: hashpassword,
        phoneNum,
        roleId,
        status: true,
        classifiedAsId: 1,
        image: profileImg,
        countryCode,
        verifiedAt: Date.now(),
    });

    if (user.classifiedAsId === 1 || user.roleId === 6) {
        await users.update(
            {
                employeeOff: agentId,
            },
            { where: { id: user.id } }
        );

        const agentAddress = await addressDb.findOne({
            where: {
                userId: agentId,
            },
        });

        const businessInfo = await bussinessInformation.findOne({
            where: {
                agentId: agentId,
            },
        });

        const zoneId = agentAddress.zoneId;
        const shopAddressId = agentAddress.id;
        const countryId = agentAddress.countryId
        const cityId = agentAddress.cityId
        const driverId = user.id;

        await driverInZones.create({
            driverId: driverId,
            zoneId: zoneId,
            laundaryShopId: businessInfo ? businessInfo.id : null,
            countryId: countryId,                                                                                                                                                                                                                                                                                                                                                                                                                                    
            cityId: cityId,
        });
    }

    return ResponseHelper.success(res, "Employee Added Sucessfully", user);
}

/*
 * Update Employee
 */
exports.updateEmployee = async (req, res) => {
    const {
        firstName,
        lastName,
        email,
        phoneNum,
        roleId,
        updatePassword,
        employeeId
    } = req.body;


    if (email) {
        const userExists = await users.findOne({
            where: {
                email: email,
                id: { [Op.not]: employeeId },
                classifiedAs: 1,
            },
        });

        if (userExists) {
            throw new ConflictError("Employee with the following email exists. Please try another email");
        }
    }


    const updatedFields = {};

    if (firstName !== undefined) updatedFields.firstName = firstName;
    if (lastName !== undefined) updatedFields.lastName = lastName;
    if (email !== undefined) updatedFields.email = email;
    if (phoneNum !== undefined) updatedFields.phoneNum = phoneNum;
    if (roleId !== undefined) updatedFields.roleId = roleId;


    if (updatePassword && updatePassword.trim() !== '') {
        const hashedPassword = await bcrypt.hash(updatePassword, 10);
        updatedFields.password = hashedPassword;
    }


    if (req.file) {
        const tempProfileImg = req.file.path;
        const profileImage = path.join('Public', 'Profile', path.basename(tempProfileImg));
        updatedFields.image = profileImage.replace(/\\/g, "/");
    }
    await users.update(updatedFields, {
        where: { id: employeeId },
    });

    return ResponseHelper.success(res, "Employee Updated Successfully", {});
}

/*
 * Change Employee status
 */
exports.changeEmployeeStatus = async (req, res) => {
    const { status, employeeId } = req.body;

    users.update(
        {
            status,
        },
        {
            where: {
                id: employeeId,
            },
        }
    );

    return ResponseHelper.success(res, "Employee Status Updated", {});
}

/*
 * Get All Employee
 */
exports.getAllEmployees = async (req, res) => {

    const agentId = req.user.id
    const agentEmployee = await users.findAll({
        where: {
            classifiedAsId: 1,
            employeeOff: agentId
        },
        attributes: ["id", "firstName", "lastName", "email", "status", "phoneNum", 'image'],
        include: [
            {
                model: roles,
                attributes: ["id", "name"],
            },
        ],
    });
    return ResponseHelper.success(res, "All Employee Fetched", { agentEmployee });
}

/*
 * Get Agent Services
 */

exports.getAgentServices = async (req, res) => {
    const agentId = req.user.id;

    const findServices = await agentSelectServices.findAll({
        where: {
            agentServiceId: agentId,
            status: true
        },
        include: [
            {
                model: service,
                attributes: ["name"],
            },
            {
                model: users,
                as: "agentServices",
                attributes: ["firstName", "lastName", "email"],
            },
        ],
    });

    return ResponseHelper.success(res, "Services Found", { findServices });
}

/*
 *  Edit Service Status
*/
exports.editServiceStatus = async (req, res) => {
    const { serviceId, status } = req.body;
    const agentId = req.user.id;

    const serviceFind = await agentSelectServices.findOne({
        where: {
            serviceId: serviceId,
            agentServiceId: agentId
        }
    });

    if (!serviceFind) {
        throw new NotFoundError("Service Not Found");
    }

    await agentSelectServices.update({ status: status }, { where: { serviceId: serviceId } });

    return ResponseHelper.success(res, "Service Status Updated", {});
}






/*
  *  Specific Service Detail For the Customer
*/
exports.serviceDetail = async (req, res) => {
    const agentId = req.user.id;


    const agentServiceFind = await agentSelectServices.findAll({
        where: {
            agentServiceId: agentId,
            status: true
        },
        attributes: ['serviceId']
    });

    const serviceIds = agentServiceFind.map(service => service.serviceId);


    const serviceData = await serviceCategories.findAll({
        where: {
            serviceId: { [Op.in]: serviceIds },
            status: true
        },
        include: [
            {
                model: service,
                attributes: ['id', 'name', 'status', 'image'],
                paranoid: false // Include soft-deleted services
            },
            {
                model: categories,
                attributes: ['id', 'name', 'status', 'image', 'description'],
                paranoid: false,
                include: [
                    {
                        model: subCategories,
                        attributes: ['id', 'name', 'status', 'price', 'description'],
                        paranoid: false
                    }
                ]
            }
        ]
    });
    


    const grouped = {};

    for (const item of serviceData) {
        const serviceId = item.service.id;
        const serviceName = item.service.name;
        const image = item.service.image

        if (!grouped[serviceId]) {
            grouped[serviceId] = {
                serviceId: serviceId,
                serviceName: serviceName,
                image: image,
                categories: []
            };
        }


        const categoryExists = grouped[serviceId].categories.find(cat => cat.id === item.category.id);
        if (!categoryExists) {
            grouped[serviceId].categories.push({
                id: item.category.id,
                name: item.category.name,
                status: item.category.status,
                image: item.category.image,
                description: item.category.description,
                subCategories: item.category.subCategories || []
            });
        }
    }

    const ServiceCategoriesList = Object.values(grouped);

    return ResponseHelper.success(res, "Service Details", { ServiceCategoriesList });
}

/*
  * Get Customer Services For Updating Invoice
*/
exports.getCustomerServicestoUpdateInvoice = async (req, res) => {
    const { bookingId } = req.query;
    const customerServices = await customerSelectedService.findAll({
        where: {
            bookingId: bookingId,
            status: true
        },
        include: [
            {
                model: service,
                attributes: ["id", "name"],
            },
            {
                model: categories,
                attributes: ["id", "name"],
            },
            {
                model: subCategories,
                attributes: ["id", "name", "price"],
            },
        ],
        attributes: ['id', 'categoryPrice', 'items']
    });

    if (!customerServices || customerServices.length === 0) {
        return res.json(
            responsefunc(
                "1",
                "No Customer Selected Services",
                { customerServices: [], totalAmount: 0 },
                ""
            )
        );
    }

    // Calculate total
    const totalAmount = customerServices.reduce((sum, item) => {
        const price = parseFloat(item.categoryPrice) || 0;
        return sum + price;
    }, 0);

    // Format each record
    const formattedServices = customerServices.map(item => ({
        id: item.id,
        serviceName: item.service.name,
        serviceId: item.service.id,
        categoryId: item.category.id,
        categoryName: item.category.name,
        subCategoryId: item.subCategory.id,
        subCategoryName: item.subCategory.name,
        subCategoryPrice: item.subCategory.price,
        categoryPrice: item.categoryPrice,
        items: item.items
    }));

    return res.json(
        responsefunc(
            "1",
            "Customer Selected Services",
            {
                customerServices: formattedServices,
                totalAmount
            },
            ""
        )
    );
}
// async function getCustomerServicestoUpdateInvoice(req, res) {
//     const { bookingId } = req.query;
//     const customerServices = await customerSelectedService.findAll({
//         where: {
//             bookingId: bookingId,
//             status: true
//         },
//         include: [
//             {
//                 model: service,
//                 attributes: ["id", "name"],
//             },
//             {
//                 model: categories,
//                 attributes: ["id", "name"],
//             },
//             {
//                 model: subCategories,
//                 attributes: ["id", "name", "price"],
//             },
//         ],
//         attributes: ['id', 'categoryPrice', 'items']
//     });

//     if (!customerServices || customerServices.length === 0) {
//         return res.json(
//             responsefunc(
//                 "1",
//                 "No Customer Selected Services",
//                 { customerServices: [], totalAmount: 0 },
//                 ""
//             )
//         );
//     }

//     // Calculate total
//     const totalAmount = customerServices.reduce((sum, item) => {
//         const price = parseFloat(item.categoryPrice) || 0;
//         return sum + price;
//     }, 0);

//     // Group services by service name
//     const groupedServices = customerServices.reduce((acc, item) => {
//         if (!item.service || !item.category || !item.subCategory) return acc;

//         const serviceName = item.service.name;

//         if (!acc[serviceName]) {
//             acc[serviceName] = {
//                 id: item.id,
//                 serviceName,
//                 serviceId: item.service.id,
//                 categories: []
//             };
//         }

//         const existingCategoryIndex = acc[serviceName].categories.findIndex(
//             category => category.name === item.category.name
//         );

//         const subCategory = {
//             id: item.subCategory.id,
//             name: item.subCategory.name,
//             price: item.subCategory.price
//         };

//         if (existingCategoryIndex === -1) {
//             acc[serviceName].categories.push({
//                 id: item.category.id,
//                 name: item.category.name,
//                 subCategories: [subCategory]
//             });
//         } else {
//             acc[serviceName].categories[existingCategoryIndex].subCategories.push(subCategory);
//         }

//         return acc;
//     }, {});

//     const formattedResponse = Object.values(groupedServices);

//     return res.json(
//         responsefunc(
//             "1",
//             "Customer Selected Services",
//             {
//                 customerServices: formattedResponse,
//                 totalAmount
//             },
//             ""
//         )
//     );
// }





//!------------------Get Countries && Cities------------------//
exports.getCountries = async (req, res) => {
    const countriesFind = await countries.findAll();

    let outObj = {
        allCountries: countriesFind,
    };

    return ResponseHelper.success(res, "Countries Fetched", outObj);
}

exports.getCities = async (req, res) => {
    const getAllCities = await cities.findAll();

    let outObj = {
        allCountries: getAllCities,
    };

    return ResponseHelper.success(res, "Fetched All Cities", outObj);
}

//!------------------Get Bussiness Information ------------------//
exports.getBussinessInforMation = async (req, res) => {
    const { userId } = req.params;

    const machineInfo = await machines.findAll();

    const findServices = await agentSelectServices.findAll({
        where: {
            agentServiceId: userId,
            status: true,
        },
        include: [
            {
                model: service,
                attributes: ["id", "name"],
            },
            {
                model: users,
                as: "agentServices",
                attributes: ["firstName", "lastName", "email"],
            },
        ],
        attributes: ["id", "status"],
    });

    let outObj = {
        allMachineInformation: machineInfo,
        agentServices: findServices,
    };

    return ResponseHelper.success(res, "Information fetched", outObj);
}

exports.getBussinessWrkinghours = async (req, res) => {
    const { userId } = req.params;

    const bussinesWorkingHours = await bussinessWorkingHours.findAll({
        where: {
            userId: userId,
        },
        attributes: [
            "id",
            "dayOfWeek",
            "openTime",
            "closeTime",
            "status",
            "userId",
        ],
    });

    let outObj = {
        bussinesWorkingHours: bussinesWorkingHours,
    };

    return ResponseHelper.success(res, "Information fetched", outObj);
}


exports.printLabelData = async (req, res) => {
    const { bookingId } = req.params
    const datafind = await booking.findAll({
        where: {
            id: bookingId
        },
        include: [
            {
                model: users,
                as: 'customer',
                attributes
            },
            {
                model: customerSelectedService,
                where: {
                    bookingId: bookingId
                },
                attributes: ['id'],
                include: [
                    {
                        model: service,
                        attributes: ['id', 'name'],
                    },
                    {
                        model: categories,
                        attributes: ['id', 'name'],
                    },
                    {
                        model: subCategories,
                        attributes: ['id', 'name', 'price', 'barCode']
                    }
                ]
            }

        ]
    })


    return ResponseHelper.success(res, "Print Label Data", {})
}


/*
  * Get On Hold Options
*/
exports.getOnHoldOptions = async (req, res) => {

    const getOptions = await onHoldOption.findAll({
        where: {
            status: true
        },
        attributes: ['id', 'option', 'status']
    })

    return ResponseHelper.success(res, "All on Hold Options Fetched", getOptions)

}


/*
  * Get Customer Services and SubCategories For onHold  
*/
exports.getCustomerServicesForOnHold = async (req, res) => {
    const { bookingId } = req.params;

    // Fetch all customer services for the given bookingId
    const customerServicesFind = await customerSelectedService.findAll({
        where: {
            bookingId: bookingId,
            status: true
        },
        include: [
            {
                model: service,
                attributes: ["id", "name"],
            },
            {
                model: subCategories,
                attributes: ["id", "name", "price"],
            },
        ],
        attributes: ['categoryPrice', 'items'],
    });

    console.log("customerServicesFind===========>", customerServicesFind)

    // Restructure the data to group subCategories under services
    const groupedServices = customerServicesFind.reduce((acc, currentService) => {
        // Check if the service already exists in the accumulator
        let existingService = acc.find(service => service.service.id === currentService.service.id);

        if (existingService) {
            // If the service exists, add the subCategory to the subCategories list
            existingService.subCategories.push({
                id: currentService.subCategory.id,
                name: currentService.subCategory.name,
                price: currentService.subCategory.price
            });
        } else {
            // If the service doesn't exist, create a new entry
            acc.push({
                service: {
                    id: currentService.service.id,
                    name: currentService.service.name
                },
                categoryPrice: currentService.categoryPrice,
                items: currentService.items,
                subCategories: [
                    {
                        id: currentService.subCategory.id,
                        name: currentService.subCategory.name,
                        price: currentService.subCategory.price
                    }
                ]
            });
        }
        return acc;
    }, []);

    // Return the grouped data in the response
    return ResponseHelper.success(res, "Services of Customer", { customerServicesFind: groupedServices });
}

/*
  *  Performance Dashboard
*/

exports.getPerformanceDashboard = async (req, res) => {
    const agentId = req.user.id;
    const { startDate, endDate } = req.query;

    // 🕐 Normalize date range
    let start = startDate ? new Date(startDate) : new Date();
    let end = endDate ? new Date(endDate) : new Date();

    if (!startDate || !endDate) {
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
    }

    // 🕐 Compute comparison period
    const durationInMs = end.getTime() - start.getTime();
    console.log("durationInMs============>>>>>>>>>>>>>>>>>>", durationInMs)
    const compStart = new Date(start.getTime() - durationInMs);
    console.log("compStart===========================================>>>>>>", compStart)
    const compEnd = new Date(start.getTime());
    console.log("compEnd===========================================>>>>>>", compEnd)

    // 🔍 Agent Shop Address
    const findAgentShopAddress = await addressDb.findOne({
        where: { userId: agentId },
    });

    // 🔹 Today's Summary
    const todaySummaryRaw = await booking.findAll({
        where: {
            laundryShopId: findAgentShopAddress.id,
            createdAt: {
                [Op.between]: [start, end]
            }
        },
        attributes: [
            [sequelize.fn('COUNT', sequelize.col('id')), 'pickups'],
            [sequelize.literal('ROUND(SUM(orderAmount), 2)'), 'earnings']
        ],
        raw: true
    });

    // 🔹 Comparison Period Summary
    const comparisonSummary = await booking.findAll({
        where: {
            laundryShopId: findAgentShopAddress.id,
            createdAt: {
                [Op.between]: [compStart, compEnd]
            }
        },
        attributes: [
            [sequelize.literal('ROUND(SUM(orderAmount), 2)'), 'earnings']
        ],
        raw: true
    });

    console.log("comparisonSummary===========-----+++++++++++++++++++++++", comparisonSummary)

    const earningsNow = parseFloat(todaySummaryRaw[0]?.earnings || 0);
    const earningsPrev = parseFloat(comparisonSummary[0]?.earnings || 0);


    const MAX_CHANGE = 200;

    let earningsDiffPercent = 0;
    if (earningsPrev > 0) {
        const rawChange = ((earningsNow - earningsPrev) / earningsPrev) * 100;

        // ✅ Scale it into 1–100 range
        const scaled = (rawChange / MAX_CHANGE) * 100;

        // Clamp result between 1 and 100
        earningsDiffPercent = Math.min(Math.max(scaled, 1), 100);

        // Round
        earningsDiffPercent = parseFloat(earningsDiffPercent.toFixed(2));
    }

    const todaySummary = {
        ...todaySummaryRaw[0],
        earningsComparison: earningsDiffPercent
    };

    // 🔹 Delivery Type Split (Agent Drivers only)
    const agentDriverIds = await users.findAll({
        where: {
            roleId: 6,
            employeeOff: agentId
        },
        attributes: ['id'],
        raw: true
    });

    const driverIds = agentDriverIds.map(d => d.id);

    let deliveryWhere = {
        [Op.or]: [
            { deliveryDriverId: { [Op.in]: driverIds } },
            { driverId: { [Op.in]: driverIds } }
        ]
    };

    if (startDate && endDate) {
        deliveryWhere.createdAt = {
            [Op.between]: [start, end]
        };
    }

    const agentDriversDeliveries = await booking.count({
        where: deliveryWhere
    });

    // 🔹 Driver Performance
    const driverPerformance = await users.findAll({
        where: { employeeOff: agentId, roleId: 6 },
        include: [{
            model: booking,
            as: 'driver',
            attributes: [],
            where: {
                createdAt: {
                    [Op.between]: [start, end]
                }
            },
            required: false
        }],
        attributes: [
            'id', 'firstName', 'lastName',
            [sequelize.fn('COUNT', sequelize.col('driver.id')), 'pickups'],
            [sequelize.fn('COUNT', sequelize.col('driver.deliveryDriverId')), 'deliveries'],
            [sequelize.literal(`AVG(TIMESTAMPDIFF(MINUTE, driver.collectionTimeTo, driver.collectionTimeFrom))`), 'collectionTimeliness'],
            [sequelize.literal(`AVG(TIMESTAMPDIFF(MINUTE, driver.deliveryTimeTo, driver.deliveryTimeFrom))`), 'deliveryTimeliness']
        ],
        group: ['users.id']
    });

    // ✅ Final Response
    const response = {
        todaySummary,
        deliveryTypeSplit: {
            agentDriversDeliveries,
            freelanceDriverDeliveries: 0
        },
        driverPerformance
    };

    return ResponseHelper.success(res, "Performance Dashboard Data", response);
}


/*
  * Update Invoice  
*/
exports.updateInvoice = async (req, res) => {
    const { services, bookingId, total } = req.body;

    console.log("Services==============================>>", services)

    if (!Array.isArray(services) || services.length === 0) {
        throw new ValidationError("Invalid request. Please provide an array of services.");
    }

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];
    console.log("Current Date:", currentDate);

    if (services.length > 0) {
        for (let service of services) {
            let itemTotalPrice = parseFloat(service.categoryCharge || 0);
            //total += itemTotalPrice;

            const existingRecords = await customerSelectedService.findAll({
                where: {
                    bookingId,
                    id: service.id,
                    serviceId: service.serviceId,
                    subCategoryId: service.subCategoryId,
                    categoryId: service.categoryId,
                }
            });

            let matched = existingRecords.find(r => r.subCategoryId === service.subCategoryId);

            // 👇 fallback: update the first one with null subCategoryId
            if (!matched) {
                matched = existingRecords.find(r => r.subCategoryId === null);
            }

            if (matched) {
                console.log(`✅ Updating existing record (id ${matched.id})`);
                await matched.update({
                    categoryId: service.categoryId,
                    categoryPrice: itemTotalPrice,
                    subCategoryId: service.subCategoryId,
                    items: service.items,
                    date: currentDate,
                    time: currentTime,
                    status: service.status
                });
            } else {
                console.log(`🆕 Creating new for subCategoryId: ${service.subCategoryId}`);
                await customerSelectedService.create({
                    date: currentDate,
                    time: currentTime,
                    bookingId: bookingId,
                    serviceId: service.serviceId,
                    categoryId: service.categoryId,
                    categoryPrice: itemTotalPrice,
                    subCategoryId: service.subCategoryId,
                    items: service.items,
                    status: service.status
                });
            }
        }
    }

    // const parsedServiceCharge = parseFloat(serviceCharge) || 0;
    // const parsedZoneMinimum = parseFloat(zoneMinimumAmount) || 0;

    // let subTotal = total;
    // console.log("Sub-Total------->>>", subTotal);

    // total += parsedServiceCharge;
    // console.log("Total Before Zone Deduction:", total);

    // total -= parsedZoneMinimum;

    // // Round to 2 decimal places
    // total = parseFloat(total.toFixed(2));
    // subTotal = parseFloat(subTotal.toFixed(2));

    // console.log("Final Total After Zone Deduction:", total);

    // if (isNaN(total)) {
    //     throw new Error("Calculated total is NaN. Please check your input values.");
    // }

    await billingDetails.update(
        {
            total,
            discount: 0,
            paymentStatus: "Pending",
        },
        { where: { bookingId: bookingId } }
    );


    await booking.update(
        {
            orderAmount: total,
        },
        { where: { id: bookingId } }
    );

    return ResponseHelper.success(res, "Invoice Updated", {});
}

//!---------------Recurring Functions-------------------------//


const findZones = async (lat, lng) => {
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
        throw new NotFoundError("No Zone found for these lat,lngs and coordinates");
    }

    return findZone;
}

const getSlotBookings = async (laundryShopId) => {
    console.log("Ã°Å¸Å¡â‚¬ ~ getSlotBookings ~ laundryShopId:", laundryShopId);

    const slots = [
        "07:00",
        "08:00",
        "09:00",
        "10:00",
        "11:00",
        "12:00",
        "13:00",
        "14:00",
        "15:00",
        "16:00",
        "17:00",
        "18:00",
    ];

    // Use map to iterate over slots and get the booking count and details for each slot
    const slotBookings = await Promise.all(
        slots.map(async (slot) => {
            const collectionTimeFrom = slot;
            const collectionTimeTo = getNextHourTime(slot);

            // Fetch the count of bookings for the current slot
            const bookingCount = await booking.count({
                where: {
                    laundryShopId: laundryShopId,
                    collectionTimeFrom: { [Op.gte]: collectionTimeFrom },
                    collectionTimeTo: { [Op.lte]: collectionTimeTo },
                },
            });
            console.log("Ã°Å¸Å¡â‚¬ ~ getSlotBookings ~ bookingCount:", bookingCount);

            // Fetch the booking details for the current slot
            const bookings = await booking.findAll({
                where: {
                    laundryShopId: laundryShopId,
                    collectionTimeFrom: { [Op.gte]: collectionTimeFrom },
                    collectionTimeTo: { [Op.lte]: collectionTimeTo },
                    bookingStatusId: { [Op.notIn]: [1, 13] } // exclude status 1 and 3
                },
                attributes: [
                    "id",
                    "ordertrackId",
                    "collectionTimeFrom",
                    "collectiontimeTo",
                    "collectionDate",
                    "deliveryTimeFrom",
                    "deliveryTimeTo",
                    "deliveryDate",
                    "driverInstructionOptions",
                    "driverInstructionOptions1",
                    "bookingStatusId"
                ],
                include: [
                    {
                        model: bookingStatus,
                        attributes: ['id', 'title', 'description']
                    }
                    ,
                    {
                        model: addressDb,
                        as: "laundryShop",
                        attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                        include: [
                            {
                                model: countries,
                                attributes: ['id', 'name', 'shortName']
                            },
                            {
                                model: cities,
                                attributes: ['id', 'name']
                            }
                        ]
                    },
                    {
                        model: addressDb,
                        as: "pickupAddress",
                        attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                        include: [
                            {
                                model: countries,
                                attributes: ['id', 'name', 'shortName']
                            },
                            {
                                model: cities,
                                attributes: ['id', 'name']
                            }
                        ]
                    },
                    {
                        model: addressDb,
                        as: "dropOffAddress",
                        attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                        include: [
                            {
                                model: countries,
                                attributes: ['id', 'name', 'shortName']
                            },
                            {
                                model: cities,
                                attributes: ['id', 'name']
                            }
                        ]
                    },
                    {
                        model: users,
                        as: "customer",
                        attributes: ["firstName", "lastName", "email", "phoneNum"],
                    },
                ],
            });

            // Return the result for each slot
            return {
                slot: `${collectionTimeFrom} - ${collectionTimeTo}`,
                bookingCount: bookingCount,
                bookings: bookings, // Include the actual booking details
            };
        })
    );

    return slotBookings;
}


const getNextHourTime = (time) => {
    const [hour, minute] = time.split(":").map(Number);
    const nextHour = hour === 12 ? 1 : hour + 1;
    return `${nextHour.toString().padStart(2, "0")}:${minute
        .toString()
        .padStart(2, "0")}`;
}


//!----------------------------Agent Postcode Lookup---------------------//



/**
 * @route GET /api/agent/postcode/:postcode
 * @access Private (Agent)
 * @description Get a list of addresses for a given UK postcode using getAddress.io.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Object} - JSON response with postcode details and a list of addresses.
 */
exports.getAddressesByPostcode = async (req, res) => {
    const { postcode } = req.params;
    const result = await customerPostcodeService.getAddressesByPostcode(postcode);
    return ResponseHelper.success(res, "Addresses fetched successfully", result);
};

/**
 * @route GET /api/agent/postcode/:postcode/address/:index
 * @access Private (Agent)
 * @description Get a specific address by postcode and index.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Object} - JSON response with address details.
 */
exports.getAddressById = async (req, res) => {
    const { postcode, index } = req.params;
    const result = await customerPostcodeService.getAddressById(postcode, parseInt(index));
    return ResponseHelper.success(res, "Address fetched successfully", result);
};

/**
 * @route POST /api/agent/postcode/validate
 * @access Private (Agent)
 * @description Validate UK postcode format.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Object} - JSON response with validation result.
 */
exports.validatePostcode = async (req, res) => {
    const { postcode } = req.body;
    const result = await customerPostcodeService.validatePostcodeFormat(postcode);
    return ResponseHelper.success(res, "Postcode validation result", result);
};


//!---------------------------------------------Controllers Converted to Export Approach----------------------------------------//

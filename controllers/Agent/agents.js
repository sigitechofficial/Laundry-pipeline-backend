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
const customError = require("../../middlewares/customError");
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

//!----------------------------------Agent Shop Address Add-----------------------------//
async function agentAddressAdd(req, res) {
    const {
        streetAddress,
        district,
        province,
        lat,
        lng,
        coordinates,
        addressType,
        userId,
    } = req.body;

    const findAgentShopAddress = await addressDb.findAll({
        where: {
            userId: userId,
        },
    });

    if (findAgentShopAddress.length > 0) {
        throw new customError("Already Added the Shop Address");
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
        coordinates: polygon,
        userId: userId,
        zoneId: fetchZones[0].id,
        addressType,
        userId,
    });

    return res.json(
        responsefunc("1", "Laundary Shhop Address Added", registerShop)
    );
}

/*
 * Get Agent Address
 */

async function getShopAddress(req, res) {
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
    return res.json(responsefunc("1", "Address Get", outObj, " "));
}

//!------------------------------------------Get Order For Agent----------------------------------------//

/*
 * Get Agent Order Home Api
 */

async function getBookingHome(req, res) {
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

    const bookingData = await booking.findAll({
        where: {
            laundryShopId: null,
            bookingStatusId: 1,
            zoneId: agentZone,
            orderExpireTime: {
                [Op.gte]: currentTimeString
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


    return res.json(
        responsefunc(
            "1",
            "Agent Orders fetched",
            { bookingData },
            ""
        )
    );
}

/*
 * Get ALl Order of Agent
 */
async function getAgentOrder(req, res) {
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

    return res.json(responsefunc("1", "Booking Available to Accept", outObj, ""));
}

/*
 * Specific Order Details
 */
async function orderDetailsById(req, res) {
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
        return res.json(
            responsefunc(
                "1",
                `Order Details for ${Object.keys(whereCondition)[0]}: ${Object.values(whereCondition)[0]
                }`,
                { bookingfind, oneHourLater },
                ""
            )
        );
    }

    return res.json(
        responsefunc(
            "1",
            `Order Details for ${Object.keys(whereCondition)[0]}: ${Object.values(whereCondition)[0]
            }`,
            bookingfind,
            ""
        )
    );
}

/*
 *  Agent booking Filters
 */

async function agentBookingFilters(req, res) {
    const agentId = req.user.id;

    const { filterType } = req.query

    const addressFound = await addressDb.findOne({
        where: { userId: agentId },
    });

    if (!addressFound) {
        return res.json(responsefunc("0", "Address not found for agent", {}, ""));
    }

    const results = {};



    // Slot bookings
    if (filterType === 'slots') {
        results.slots = await getSlotBookings(addressFound.id);
        return res.json(responsefunc("1", "Booking Details Fetched for all filters", results, ""));
    }


    // All bookings (any booking with this laundryShopId)
    results.All = await booking.findAll({
        where: {
            laundryShopId: addressFound.id,
            bookingStatusId: {
                [Op.ne]: [1, 13]
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

    return res.json(responsefunc("1", "Booking Details Fetched for all filters", results, ""));
}




async function invoiceDetailTab(req, res) {
    const agentId = req.user.id;


    const addressFound = await addressDb.findOne({
        where: { userId: agentId },
    });

    if (!addressFound) {
        return res.json(responsefunc("0", "Address not found for agent", {}, ""));
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

    return res.json(responsefunc("1", "Booking Details Fetched for all filters", results, ""));
}



/*
 *   Agent Booking status Update to one the way
 */
async function agentBookingStatusOnTheWay(req, res) {
    const { bookingId } = req.params;

    const bookingfind = await booking.findOne({
        where: {
            id: bookingId,
        },
    });
    console.log("ðŸš€ ~ agentBookingStatusOnTheWay ~ bookingfind:", bookingfind);

    //return res.json(bookingfind)

    if (!bookingfind) {
        throw new customError(`Booking with this ${bookingId} not exists`);
    }

    if (bookingfind.bookingStatusId !== 3) {
        throw new customError("No driver is assigned to your booking Yet");
    }

    await booking.update(
        {
            bookingStatusId: 4,
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
        bookingId: bookingId,
        date: currentDate,
        time: currentTime,
        bookingStatusId: 4,
    });

    return res.json(
        responsefunc("1", "Booking Status Updated Sucesfully", {}, " ")
    );
}

/*
 *   Agent Booking status Arrived
 */ async function driverStatusArrived(req, res) {
    const { bookingId } = req.params;

    const bookingfind = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (!bookingfind) {
        throw new customError(`Booking with this  id : ${bookingId} not exists`);
    }

    if (bookingfind.bookingStatusId !== 4) {
        throw new customError("Your driver is still not out for pickup");
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
    return res.json(
        responsefunc("1", "Booking Status Updated to Driver Arrived", {}, " ")
    );
}

/*
 *   Driver/Agent Add pictures of pickup and delivery
 */
async function AddPickupDeliveryProof(req, res) {
    const { noOfItems, note, bookingId, deliveryType } = req.body;
    console.log("ðŸš€ ~ AddPickupDeliveryProof ~ req.body:", req.body);
    const userId = req.user.id;

    if (!req.files.length) {
        throw new customError(
            "Proof Images are not uploaded",
            "Please Upload the Images"
        );
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

    return res.json(
        responsefunc("1", "Driver proof Pics Uploaded Successfully", {}, "")
    );
}

/*
 *   Agent PickingUp and Inspection Status Update
 */

async function agentInspectionStatus(req, res) {
    const { bookingId } = req.params;

    const bookingFind = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingFind.bookingStatusId !== 5) {
        throw new customError("Your driver is not reached yet");
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

    return res.json(
        responsefunc("1", "Booking PickingUp and Inspection Status Updated", {}, "")
    );
}

/*
 *   Agent/Driver Reached to the Delivery Shop Status Update
 */
async function reachedAtDeliveryShopStatus(req, res) {
    const { bookingId } = req.params;

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingCheck.bookingStatusId !== 7) {
        throw new customError("Booking is still not In Transit to Facility");
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

    return res.json(responsefunc("1", "Driver Reached At Laundry Shop", {}, ""));
}



/*
 *   Laundry Status Updated Invoice Generated and Status goes to In-Procesing
 */
async function bookingInvoiceGeneratedStatusUpdated(req, res) {
    const { bookingId } = req.params;

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingCheck.bookingStatusId !== 9) {
        throw new customError("Booking is still not In Transit to Facility");
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


    const statusId = [10, 11];
    const bookinghistories = statusId.map(statusId => ({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: statusId
    }))
    await bookingHistory.bulkCreate(bookinghistories);

    return res.json(responsefunc("1", "Driver Reached At Laundry Shop", {}, ""));
}


/*
 *   Laundry Status Updated That laundry is Washed
 */
async function laundryWashCompleted(req, res) {
    const { bookingId } = req.params;


    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingCheck.bookingStatusId !== 11) {
        throw new customError("Booking is still not In Procesing or Invoice Not Generated");
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
    return res.json(responsefunc("1", "Laundry Has Been Washed At Shop", {}, ""));
}

/*
 *   Laundry Status Updated That Laundry is Out for Delivery to Customer
 */
async function laundryDeliverToCustomer(req, res) {
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

    return res.json(
        responsefunc(
            "1",
            "Driver updated and out for Deliver Laundry to Customer",
            {},
            ""
        )
    );
}

/*
 *   Driver Reached at customer Destination
 */
async function driverReachedForDelivery(req, res) {
    const { bookingId } = req.params;

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingCheck.bookingStatusId !== 13) {
        throw new customError("Driver is not out to deliver your laundry");
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

    return res.json(responsefunc("1", "Driver reached for delivery", {}, ""));
}

/*
 *   Booking Deliver to Customer (Delivery)
 */
async function bookingDeliverToCustomer(req, res) {
    const { bookingId } = req.params;

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingCheck.bookingStatusId !== 14) {
        throw new customError("Driver not reached yet at customer destination");
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


    return res.json(
        responsefunc("1", "Laundry Delivered to customer sucessfully", {}, "")
    );
}

//!-----------------------------Booking Step-2 When Agent/Driver Added the Services------------------------//

/*
 * Agent Add Services At the time of Invoice
 */

async function driverAddSerivces(req, res) {
    const { services, bookingId, zoneMinimumAmount, serviceCharge } = req.body;

    if (!Array.isArray(services) || services.length === 0) {
        throw new customError("Invalid request. Please provide an array of services.");
    }

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];
    console.log("Current Date:", currentDate);

    let total = 0;

    if (services.length > 0) {
        for (let service of services) {
            const itemTotalPrice = parseFloat(service.categoryCharge || 0);
            total += itemTotalPrice;

            const existingRecords = await customerSelectedService.findAll({
                where: {
                    bookingId,
                    serviceId: service.serviceId
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
                    time: currentTime
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
                    items: service.items
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

    // Round to 2 decimal places
    total = parseFloat(total.toFixed(2));
    subTotal = parseFloat(subTotal.toFixed(2));

    console.log("Final Total After Zone Deduction:", total);

    if (isNaN(total)) {
        throw new Error("Calculated total is NaN. Please check your input values.");
    }

    await billingDetails.update(
        {
            total,
            discount: 0,
            paymentStatus: "Pending",
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

    return res.json(responsefunc("1", "Agent/Driver Added Detail", {}, ""));
}


/*
 *  Invoice Creation
 */
async function invoiceCreation(req, res) {
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
                attributes: ["firstName", "lastName", "email", "phoneNum", "image"]
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
                    "date", "time", "categoryPrice", "bookingId",
                    "categoryId", "serviceId", "subCategoryId", "items"
                ]
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
        return res.status(404).json(responsefunc("0", "No invoice data found", {}, ""));
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

    return res.json(responsefunc("1", "Invoice Details", {
        invoiceDetails: bookingData,
        remainingTime
    }, ""));
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
async function customerServices(req, res) {
    const { bookingId } = req.query;

    const customerServicesFind = await customerSelectedService.findAll({
        where: {
            bookingId: bookingId,
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
        attributes: ['categoryPrice', 'items']
    });

    if (!customerServicesFind || customerServicesFind.length === 0) {
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
            price: item.subCategory.price
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

    return res.json(
        responsefunc(
            "1",
            "Customer Selected Services",
            {
                customerServices: formattedResponse,
                totalAmount
            },
            ""
        )
    );
}


/*
 * on Hold Conformation
 */
async function onHoldConformation(req, res) {
    const { serviceId, subCategoryId, bookingId, noOfItems, description } =
        req.body;

    let onHoldImg = [];
    if (req.files) {
        req.files.forEach(file => {
            onHoldImg.push(file.path.replace(/\\/g, "/"));
        });
    }

    const createConformation = await OnHoldConfirmation.create({
        serviceId,
        subCategoryId,
        bookingId,
        noOfItems,
        description,
        onHoldImg,
    });

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];
    console.log(currentDate); // Example: "2025-01-28"

    await booking.update(
        {
            bookingStatusId: 24,
        },
        { where: { id: bookingId } }
    );

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: 24,
    });

    return res.json(
        responsefunc("1", "Hold Conformation Submitted", {createConformation}, "")
    );
}

/*
 * Agent Update Status To issue resoved
 */
async function agentIssueResolved(req, res) {
    const { bookingId } = req.params;

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (bookingCheck.bookingStatusId !== 22) {
        throw new customError("Booking customer Response is not confirmed");
    }

    await booking.update(
        {
            bookingStatusId: 19,
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
        bookingStatusId: 19,
    });

    return res.json(
        responsefunc("1", "Booking Status Updated Issue Resolved", {}, "")
    );
}

//!-------------------------Agent Drivers-------------------------------//
/*
 *     All Agent Laundry Drivers
 */
async function agnetDrivers(req, res) {
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
async function agentAssignBookingToLaundryDriver(req, res) {
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
    return res.json(responsefunc("1", "Order Assign to Laundry Driver", {}, ""));
}

/*
 * Agent pickup order BySelf
 */
async function agentPickupOrderBySelf(req, res) {
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

    return res.json(responsefunc("1", "Agent Assigned To PickUp Order", {}, ""));
}

//!-----------------------------------Agent Cancel Booking------------------------------------//
async function agentCancelBooking(req, res) {
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

    return res.json(responsefunc("1", "Booking Cancelled Sucessfully", {}, ""));
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

    let bulkArray = permissionRole.map((ele) => ({
        featureId: ele.id,
        roleId: newRole.id,
        read: ele.permissions.read || false,
        write: ele.permissions.write || false
    }));

    await permissions.bulkCreate(bulkArray);

    return res.json(responsefunc("1", "Role and Permission Added Successfully", {}, ""));
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

    
    const bulkArray = permissionRole.map((ele) => ({
        featureId: ele.id,
        roleId,
        read: ele.permissions.read || false,
        write: ele.permissions.write || false
    }));

    
    await permissions.bulkCreate(bulkArray);

    return res.json(responsefunc("1", "Role updated successfully", {}, ""));
}

/*
 * Get All Roles
 */
async function getAllRoles(req, res) {
    const getRoles = await roles.findAll({
        where: {
            status: true,
            classifiedAsId: 1,
        },
        attributes: ["id", "name", "status"],
    });

    return res.json(responsefunc("1", "Get All Roles", {getRoles}, " "));
}


/*
 * Get Permissions
 */
async function getPermissions(req, res) {
    const roleId = req.query.roleId;
    const getPermissions = await permissions.findAll({
        where: {
            status: true,
            roleId: roleId
        },
        include:[
            {
                model: features,
                attributes: ['id', 'name', 'status']
            },
            {
                model: roles,
                attributes: ['id', 'name', 'status']
            },
        ],
        attributes: ['id', 'permissionType','read', 'write', 'featureId', 'roleId']
    });
    return res.json(responsefunc("1", "Get All Permissions", {getPermissions}, " "));
}







/*
 * Add Classified
 */
async function addClassifiedAs(req, res) {
    const { name } = req.body;
    const createData = await classifiedAs.create({
        name,
    });
    return res.json(responsefunc("1", "Added the classified As", createData, ""));
}

/*
 * Get ClassifiedAs
 */
async function getClassifiedAs(req, res) {
    const findData = await classifiedAs.findAll({
        attributes: ["id", "name"],
    });

    return res.json(
        responsefunc("1", "Fetched All ClassifiedAs Roles", findData, " ")
    );
}

/*
 * Add Features
 */
async function addfeatures(req, res) {
    const { title, status, featureOf, key } = req.body;

    const titleFound = await features.findOne({
        where: {
            title: title,
            key: key,
        },
    });

    if (titleFound) {
        throw new customError("Feature Alreay Exists");
    }

    const createFeatures = await features.create({
        title,
        status,
        featureOf,
        key,
    });
    return res.json(responsefunc("1", "Feature Added", createFeatures, ""));
}

/*
 * Get Features
 */
async function getFeatures(req, res) {
    const findFeature = await features.findAll({
        where: {
            status: true,
        },
        attributes: ["id", "name", "status"],
    });

    return res.json(responsefunc("1", "All Features Fetched", findFeature, " "));
}

//!------------------------------Agent Add Employees--------------------------//
/*
 * Add Employee
 */

async function addEmployee(req, res) {
    const {
        firstName,
        lastName,
        email,
        password,
        phoneNum,
        countryId,
        cityId,
        roleId,
    } = req.body;

    const agentId = req.user.id;

    const userFind = await users.findOne({
        where: {
            classifiedAsId: 1,
            roleId: roleId,
        },
    });

    if (userFind) {
        throw new customError("Employee Already Exists");
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

        const zoneId = agentAddress.zoneId;
        const shopAddressId = agentAddress.id;
        const driverId = user.id;

        await driverInZones.create({
            driverId: driverId,
            zoneId: zoneId,
            laundaryShopId: shopAddressId,
            countryId,
            cityId,
        });
    }

    return res.json(responsefunc("1", "Employee Added Sucessfully", user, ""));
}

/*
 * Update Employee
 */
async function updateEmployee(req, res) {
    const {
        firstName,
        lastName,
        email,
        phoneNum,
        roleId,
        updatePassword,
        employeeId,
    } = req.body;

    const userExists = await users.findOne({
        where: {
            email: email ? email : null,
            id: { [Op.not]: employeeId },
            classifiedAs: 1,
        },
    });

    if (userExists) {
        throw new customError(
            "Employee with the following email exists",
            "Please try another email"
        );
    }

    if (updatePassword) {
        let hashpassword = await bcrypt.hash(updatePassword, 10);
        users.update(
            {
                firstName,
                lastName,
                email,
                password: hashpassword,
                phoneNum,
                roleId,
            },
            { where: { id: employeeId } }
        );
    } else {
        users.update(
            {
                firstName,
                lastName,
                email,
                roleId,
            },
            { where: { id: employeeId } }
        );
    }

    return res.json(responsefunc("1", "Employee Updated Sucesfully", {}, ""));
}

/*
 * Change Employee status
 */
async function changeEmployeeStatus(req, res) {
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

    return res.json(responsefunc("1", "Employee Status Updated", {}, ""));
}

/*
 * Get All Employee
 */
async function getAllEmployees(req, res) {
    const agentEmployee = await users.findAll({
        where: {
            classifiedAsId: 1,
        },
        attributes: ["id", "firstName", "lastName", "email", "status", "phoneNum"],
        include: [
            {
                model: roles,
                attributes: ["id", "name"],
            },
        ],
    });
    return res.json(
        responsefunc("1", "All Employee Fetched", agentEmployee, " ")
    );
}

/*
 * Get Agent Services
 */

async function getAgentServices(req, res) {
    const agentId = req.user.id;

    const findServices = await agentSelectServices.findAll({
        where: {
            agentServiceId: agentId,
            status: true,
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

    return res.json(responsefunc("1", "Services Found", findServices, ""));
}

/*
  *  Specific Service Detail For the Customer
*/
async function serviceDetail(req, res) {
    const agentId = req.user.id;


    const agentServiceFind = await agentSelectServices.findAll({
        where: { agentServiceId: agentId },
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
                attributes: ['id', 'name', 'status', 'image']
            },
            {
                model: categories,
                attributes: ['id', 'name', 'status', 'image', 'description'],
                include: [
                    {
                        model: subCategories,
                        attributes: ['id', 'name', 'status', 'price', 'description']
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

    return res.json(responsefunc("1", "Service Details", { ServiceCategoriesList }, ""));
}

//!------------------Get Countries && Cities------------------//
async function getCountries(req, res) {
    const countriesFind = await countries.findAll();

    let outObj = {
        allCountries: countriesFind,
    };

    return res.json(responsefunc("1", "Countries Fetched", outObj, ""));
}

async function getCities(req, res) {
    const getAllCities = await cities.findAll();

    let outObj = {
        allCountries: getAllCities,
    };

    return res.json(responsefunc("1", "Fetched All Cities", outObj, ""));
}

//!------------------Get Bussiness Information ------------------//
async function getBussinessInforMation(req, res) {
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

    return res.json(responsefunc("1", "Information fetched", outObj, ""));
}

async function getBussinessWrkinghours(req, res) {
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

    return res.json(responsefunc("1", "Information fetched", outObj, ""));
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


    return res.json(responsefunc("1", "Print Label Data"))
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

//!---------------Recurring Functions-------------------------//

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

async function getSlotBookings(laundryShopId) {
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


function getNextHourTime(time) {
    const [hour, minute] = time.split(":").map(Number);
    const nextHour = hour === 12 ? 1 : hour + 1;
    return `${nextHour.toString().padStart(2, "0")}:${minute
        .toString()
        .padStart(2, "0")}`;
}

//!---------------------------------------------Exports----------------------------------------//

module.exports = {
    //----------------------Agent Booking Related Api's--------------------//
    agentAddressAdd,
    getAgentOrder,
    orderDetailsById,
    getShopAddress,
    invoiceCreation,
    agentCancelBooking,
    agnetDrivers,
    agentAssignBookingToLaundryDriver,
    agentPickupOrderBySelf,
    driverAddSerivces,
    AddPickupDeliveryProof,
    agentBookingStatusOnTheWay,
    driverStatusArrived,
    agentInspectionStatus,
    reachedAtDeliveryShopStatus,
    laundryWashCompleted,
    laundryDeliverToCustomer,
    agentBookingFilters,
    driverReachedForDelivery,
    bookingDeliverToCustomer,
    invoiceDetailTab,
    bookingInvoiceGeneratedStatusUpdated,
    //----------------ClassifiedAs--------------//
    addClassifiedAs,
    getClassifiedAs,
    //----------------------Features-----------//
    addfeatures,
    getFeatures,
    //--------------------Roles--------------//
    addRole,
    updateRoles,
    getAllRoles,
    getPermissions,
    //------------------------Employees-----------//
    addEmployee,
    updateEmployee,
    changeEmployeeStatus,
    getAllEmployees,
    //--------------------Agent Services------------//
    getAgentServices,
    serviceDetail,
    //-------------------Customer Services-------//
    customerServices,
    //-----------Booking OnHold--------------//
    onHoldConformation,
    agentIssueResolved,
    //--------------Get coutries && cities----------//
    getCountries,
    getCities,
    //-------------Get Bussines Information-------//
    getBussinessInforMation,
    getBussinessWrkinghours,
    //-------------Agent Home Api------//
    getBookingHome,
    //-------------Get On Hold Options-------//
    getOnHoldOptions,
}

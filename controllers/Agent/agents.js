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
    agentSelectServices,
    bussinessInformation,
    bussinessWorkingHours,
    proofOfDeliveries,
    OnHoldConfirmation,
    machines,
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
    console.log("🚀 ~ agentAddressAdd ~ fetchZones:", fetchZones[0].id);
    console.log("🚀 ~ agentAddressAdd ~ fetchZones:", fetchZones[0].city.id);
    console.log(
        "🚀 ~ agentAddressAdd ~ fetchZones:",
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
    console.log("🚀 ~ getShopAddress ~ findAddress:", findAddress.id);

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
    //console.log("🚀 ~ getShopAddress ~ findAddress:", findAddress);
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
    console.log("🚀 ~ getBookingHome ~ agentZone:", agentZone);
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
                attributes: ["id", "streetAddress", "lat", "lng", "addressType"],
            },
        ],
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
    console.log("🚀 ~ getAgentOrder ~ getBooking:", getBooking);

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
    console.log("🚀 ~ orderDetailsById ~ whereCondition:", whereCondition);

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
    const { filterType } = req.query;
    console.log("🚀 ~ agentBookingFilters ~ req.query:", req.query);

    const agentId = req.user.id;

    const addressFound = await addressDb.findOne({
        where: {
            userId: agentId,
        },
    });
    console.log("🚀 ~ agentBookingFilters ~ addressFound:", addressFound.id);

    let whereCondition = {};

    if (filterType === "pick") {
        whereCondition = {
            bookingStatusId: 4,
            laundryShopId: addressFound.id,
        };
    } else if (filterType === "drop") {
        whereCondition = {
            bookingStatusId: 8,
            laundryShopId: addressFound.id,
        };
    } else if (filterType === "slots") {
        const slotBookings = await getSlotBookings(addressFound.id);
        return res.json(
            responsefunc("1", `Booking Details Fetch for slots`, slotBookings, "")
        );
    } else if (filterType === "maps") {
        const bookingFound = await booking.findAll({
            where: {
                laundryShopId: addressFound.id,
            },
            include: [
                {
                    model: addressDb,
                    as: "pickupAddress",
                    attributes: ["lat", "lng"],
                },
                {
                    model: addressDb,
                    as: "dropOffAddress",
                    attributes: ["lat", "lng"],
                },
            ],
            attributes: ["id", "ordertrackId"],
        });

        return res.json(responsefunc("1", "All Address Fetched", bookingFound, ""));
    } else if (filterType === "All") {
        whereCondition = {
            laundryShopId: addressFound.id,
        };
    }

    const bookingFound = await booking.findAll({
        where: whereCondition,
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
        ],
        include: [
            {
                model: addressDb,
                as: "laundryShop",
                attributes: [
                    "streetAddress",
                    "district",
                    "province",
                    "addressType",
                    "lat",
                    "lng",
                ],
            },
            {
                model: users,
                as: "customer",
                attributes: ["firstName", "lastName", "email", "phoneNum"],
            },
        ],
    });

    return res.json(
        responsefunc(
            "1",
            `Booking Details Fetch on the basis of ${filterType}`,
            bookingFound,
            ""
        )
    );
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
    console.log("🚀 ~ agentBookingStatusOnTheWay ~ bookingfind:", bookingfind);

    //return res.json(bookingfind)

    if (!bookingfind) {
        throw new customError(`Booking with this ${bookingId} not exists`);
    }

    if (bookingfind.bookingStatusId !== 4) {
        throw new customError("No driver is assigned to your booking Yet");
    }

    await booking.update(
        {
            bookingStatusId: 13,
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
        bookingStatusId: 13,
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

    if (bookingfind.bookingStatusId !== 13) {
        throw new customError("Your driver is still not out for pickup");
    }

    await booking.update(
        {
            bookingStatusId: 20,
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
        bookingStatusId: 20,
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
    const { noOfItems, note, bookingId } = req.body;
    console.log("🚀 ~ AddPickupDeliveryProof ~ req.body:", req.body);
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
            bookingStatusId: 5,
            totalitems: noOfItems,
        },
        {
            where: { id: bookingId },
        }
    );

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: 5,
    });

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

    if (bookingFind.bookingStatusId !== 20) {
        throw new customError("Your driver is not reached yet");
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

    if (bookingCheck.bookingStatusId !== 5) {
        throw new customError("Booking is still not In Transit to Facility");
    }

    await booking.update(
        {
            bookingStatusId: 6,
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
        bookingStatusId: 6,
    });

    return res.json(responsefunc("1", "Driver Reached At Laundry Shop"));
}

/*
 *   Laundry Status Updated That laundry is Washed
 */
async function laundryWashCompleted(req, res) {
    const { bookingId } = req.params;

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
        bookingStatusId: 8,
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
                bookingStatusId: 21,
                deliveryDriverId: driverId,
            },
            { where: { id: bookingId } }
        );
    } else {
        await booking.update(
            {
                bookingStatusId: 21,
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
        bookingStatusId: 21,
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

    if (bookingCheck.bookingStatusId !== 21) {
        throw new customError("Driver is not out to deliver your laundry");
    }

    await booking.update(
        {
            bookingStatusId: 20,
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
        bookingStatusId: 20,
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

    if (bookingCheck.bookingStatusId !== 20) {
        throw new customError("Driver not reached yet at customer destination");
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
        bookingId: bookingId,
        bookingStatusId: 12,
    });

    return res.json(
        responsefunc("1", "Laundry Delivered to customer sucessfully", {}, "")
    );
}

//!-----------------------------Booking Step-2 When Agent/Driver Added the Services------------------------//

/*
 * Agent Add Services At the time of Invoice
 */

async function driverAddSerivces(req, res) {
    const { services, bookingId } = req.body;

    if (!Array.isArray(services) || services.length === 0) {
        throw new customError(
            "Invalid request. Please provide an array of services."
        );
    }

    const currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    const currentDate = new Date().toISOString().split("T")[0];
    console.log(currentDate); // Example: "2025-01-28"

    let total = 0;
    if (services && services.length > 0) {
        for (let service of services) {
            const itemTotalPrice = parseFloat(service.categoryCharge || 0);
            console.log("🚀 ~ driverAddSerivces ~ itemTotalPrice:", itemTotalPrice);
            total += itemTotalPrice;
            console.log("🚀 ~ driverAddSerivces ~ total:", total);
            await customerSelectedService.update(
                {
                    categoryId: service.categoryId,
                    categoryPrice: itemTotalPrice,
                    subCategoryId: service.subCategoryId,
                    items: service.items,
                },
                {
                    where: {
                        serviceId: service.serviceId,
                        bookingId: bookingId,
                    },
                }
            );
        }
    }

    const discount = 0;

    await billingDetails.update(
        {
            total,
            discount,
            paymentStatus: "Pending",
        },
        { where: { bookingId: bookingId } }
    );

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: 17,
    });

    await booking.update(
        {
            orderAmount: total,
            bookingStatusId: 17,
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
    const invoiceDetails = await booking.findOne({
        where: {
            id: bookingId,
        },
        include: [
            {
                model: users,
                as: "customer",
                include: [
                    {
                        model: countries,
                        attributes: ["name", "shortName", "image"],
                    },
                    {
                        model: cities,
                        attributes: ["name", "lat", "lng"],
                    },
                ],
                attributes: ["firstName", "lastName", "email", "phoneNum"],
            },
            {
                model: addressDb,
                as: "pickupAddress",
                attributes: [
                    "title",
                    "streetAddress",
                    "district",
                    "province",
                    "postalcode",
                    "addressType",
                ],
            },
            {
                model: addressDb,
                as: "dropOffAddress",
                attributes: [
                    "title",
                    "streetAddress",
                    "district",
                    "province",
                    "postalcode",
                    "addressType",
                ],
            },
            {
                model: customerSelectedService,
                required: true,
                include: [
                    {
                        model: service,
                        required: true,
                        attributes: { exclude: ["createdAt", "updatedAt", "timeRequired"] },
                    },
                    {
                        model: categories,
                        required: true,
                        attributes: { exclude: ["createdAt", "updatedAt"] },
                    },
                    {
                        model: subCategories,
                        required: true,
                        attributes: { exclude: ["createdAt", "updatedAt"] },
                    },
                ],
                attributes: [
                    "date",
                    "time",
                    "categoryPrice",
                    "bookingId",
                    "categoryId",
                    "serviceId",
                    "subCategoryId",
                    "items",
                ],
            },
            {
                model: billingDetails,
                required: true,
                attributes: ["upfrontAmount", "total", "paymentStatus"],
            },
            {
                model: bookingStatus,
                attributes: ["title", "description"],
            },
            {
                model: bookingHistory,
                include: [
                    {
                        model: bookingStatus,
                        attributes: ["title", "description"],
                    },
                ],
                attributes: ["date", "time", "bookingId", "bookingStatusId"],
            },
        ],
        attributes: { exclude: ["categoryId", "serviceId", "subCategoryId"] },
    });

    return res.json(responsefunc("1", "Invoice Details", invoiceDetails, ""));
}

/*
 * Customer Selected Sevices && Items
 */
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
    });
    console.log(
        "🚀 ~ customerServices ~ customerServicesFind:",
        customerServicesFind
    );

    return res.json(
        responsefunc(
            "1",
            "Custoemr Selected Services",
            { customerServices: customerServicesFind },
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

    let onHoldImg = null;
    if (req.file) {
        let tempProfileImg = req.file.path;
        onHoldImg = tempProfileImg.replace(/\\/g, "/");
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
            bookingStatusId: 7,
        },
        { where: { id: bookingId } }
    );

    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: 7,
    });

    return res.json(
        responsefunc("1", "Hold Conformation Submitted", createConformation, "")
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
    console.log("🚀 ~ agnetDrivers ~ laundryShopFound:", laundryShopFound);
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
    console.log("🚀 ~ agnetDrivers ~ driverFound:", driverFound);
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
    console.log("🚀 ~ agentCancelBooking ~ getBookingData:", getBookingData);

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
        bookingStatusId: 3,
        reasonId: reasonId,
    });

    await booking.update(
        {
            bookingStatusId: 3,
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

    return res.json(
        responsefunc("1", "Role and Permission Added Sucesfully", {}, "")
    );
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
            status: true,
        },
        attributes: ["id", "name", "status"],
    });

    return res.json(responsefunc("1", "Get All Roles", getRoles, " "));
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
    console.log("🚀 ~ getSlotBookings ~ laundryShopId:", laundryShopId);

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

    let slotBookings = [];

    for (let slot of slots) {
        const collectionTimeFrom = slot;
        const collectionTimeTo = getNextHourTime(slot);

        const bookingCount = await booking.count({
            where: {
                laundryShopId: laundryShopId,
                collectionTimeFrom: { [Op.gte]: collectionTimeFrom },
                collectionTimeTo: { [Op.lte]: collectionTimeTo },
            },
        });
        console.log("🚀 ~ getSlotBookings ~ bookingCount:", bookingCount);

        slotBookings.push({
            slot: `${collectionTimeFrom} - ${collectionTimeTo}`,
            bookingCount: bookingCount,
        });
    }

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
    //------------------------Employees-----------//
    addEmployee,
    updateEmployee,
    changeEmployeeStatus,
    getAllEmployees,
    //--------------------Agent Services------------//
    getAgentServices,
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
};

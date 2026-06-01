require("dotenv").config();
const {
    booking,
    customerSelectedService,
    servicePreferences,
    billingDetails,
    bookingHistory,
    users,
    address,
    addressDb,
    zone,
    cities,
    countries,
    bussinessInformation,
    agentSelectServices,
    service,
    categories,
    subCategories,
    OnHoldConfirmation,
    onHoldOption,
    onHoldCustomerOption,
    bookingStatus,
    serviceCategories,
    tip,
    bookingPreference,
    serviceWithPreferences,
    preferenceTypes,
    preferenceValues,
    proofOfDeliveries,
    policy,
    cancellationPolicyConfig,
    noShowPolicyConfig,
    units,
    customerSelectedServiceAddOn,
    addOnServices
} = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('sequelize');
const serviceManagementService = require('../Admin/serviceManagementService');
const otpGenerator = require('otp-generator');
const { sendEvent } = require('../../socket_io');
const {
    ValidationError,
    NotFoundError,
    UnauthorizedError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');
const { assertDeliveryMeetsTurnaround } = require('../../utils/turnaroundTime');
const { literal, fn, col } = require("sequelize");
const moment = require('moment-timezone');
const { BUSINESS_TIME_ZONE, getOrderExpireTime } = require('../../utils/bookingTimeZone');


// Import stripe functions
const { attachPaymentMethodToCustomer, getIntent, createPaymentIntend, createSetupIntent, paymentIntentGet } = require('../../controllers/stripe');

// Import coupon service
const couponService = require('./couponService');

/**
 * Helper Functions (moved from customerOrders controller to avoid circular dependency)
 */


// Shared include config for zone queries
const zoneInclude = [
    {
        model: cities,
        required: true,
        attributes: ["id", "name", "lat", "lng", "status"],
        where: { deletedAt: { [Op.is]: null } },
        include: [
            {
                model: countries,
                required: true,
                attributes: ["id", "name", "shortName", "status"],
                where: { deletedAt: { [Op.is]: null } },
            },
        ],
    },
    {
        model: units,
        as: 'currencyUnitZ',
        required: false,
        attributes: ["id", "name", "symbol"]
    }
];

const zoneAttributes = ["id", "name", "zoneMinimumAmount", "serviceCharge", "status", "coordinates", "currencyUnitId", "postcodes"];

/**
 * Extract UK outcode from a full postcode.
 * e.g. "SW1A 1AA" → "SW1A", "NW11AA" → "NW1"
 */
function extractOutcode(postcode) {
    const normalized = postcode.trim().replace(/\s+/g, '').toUpperCase();
    // Remove last 3 chars (incode: digit + 2 letters) to get outcode
    return normalized.slice(0, normalized.length - 3);
}

/**
 * Find zone by postcode using JSON_CONTAINS.
 * Checks for exact full postcode match AND outcode match so that a zone
 * stored as "SW1A" will be found when the address postcode is "SW1A 1AA".
 */
async function findZoneByPostcode(postcode) {
    const normalized = postcode.trim().replace(/\s+/g, '').toUpperCase();
    const outcode = extractOutcode(normalized);

    console.log(`🔍 Postcode lookup — full: "${normalized}", outcode: "${outcode}"`);

    // 1) Prefer exact full-postcode match first (most specific)
    const exactZones = await zone.findAll({
        where: {
            status: true,
            [Op.and]: [
                sequelize.where(
                    sequelize.fn('JSON_CONTAINS', sequelize.col('postcodes'), JSON.stringify(normalized)),
                    true
                )
            ]
        },
        include: zoneInclude,
        attributes: zoneAttributes,
    });

    if (exactZones.length > 0) {
        console.log(`📮 Postcode exact lookup found ${exactZones.length} zone(s)`);
        return exactZones;
    }

    // 2) Fallback to outcode match (can be broader and return multiple)
    const outcodeZones = await zone.findAll({
        where: {
            status: true,
            [Op.and]: [
                sequelize.where(
                    sequelize.fn('JSON_CONTAINS', sequelize.col('postcodes'), JSON.stringify(outcode)),
                    true
                )
            ]
        },
        include: zoneInclude,
        attributes: zoneAttributes,
    });

    console.log(`📮 Postcode outcode lookup found ${outcodeZones.length} zone(s)`);
    return outcodeZones;
}

/**
 * If multiple zones match, choose the nearest zone by centroid distance.
 * This avoids deterministic-but-wrong "lowest id wins" behavior.
 */
async function pickNearestZoneByCentroid(candidateZones, lat, lng) {
    if (!Array.isArray(candidateZones) || candidateZones.length <= 1) {
        return candidateZones || [];
    }

    const zoneIds = candidateZones
        .map((z) => z?.id)
        .filter((id) => Number.isInteger(id));

    if (zoneIds.length <= 1) {
        return [candidateZones[0]];
    }

    const safeLat = Number(lat);
    const safeLng = Number(lng);
    if (!Number.isFinite(safeLat) || !Number.isFinite(safeLng)) {
        console.warn("⚠️ Invalid coordinates for nearest-zone tie-break; using first candidate");
        return [candidateZones[0]];
    }

    const pointWkt = `POINT(${safeLng} ${safeLat})`;

    const nearestZone = await zone.findOne({
        where: {
            status: true,
            id: { [Op.in]: zoneIds }
        },
        include: zoneInclude,
        attributes: [
            ...zoneAttributes,
            [
                sequelize.fn(
                    "ST_Distance",
                    sequelize.fn("ST_Centroid", sequelize.col("coordinates")),
                    sequelize.fn("ST_GeomFromText", pointWkt)
                ),
                "centroidDistance"
            ]
        ],
        order: [
            [sequelize.literal("centroidDistance"), "ASC"],
            ["id", "ASC"]
        ]
    });

    if (nearestZone) {
        console.log(`📍 Multiple zones matched; nearest centroid zoneId=${nearestZone.id}`);
        return [nearestZone];
    }

    return [candidateZones[0]];
}

// Find zones function
async function findZones(lat, lng) {
    console.log("Finding zones for coordinates:", { lat, lng });

    // ── Step 1: Reverse-geocode lat/lng → postcode via postcodes.io ──────────
    let postcodeLookupResult = null;
    try {
        const axios = require('axios');
        const response = await axios.get(
            `https://api.postcodes.io/postcodes?lon=${lng}&lat=${lat}`,
            { timeout: 5000 }
        );
        if (response.data.status === 200 && response.data.result && response.data.result.length > 0) {
            postcodeLookupResult = response.data.result[0].postcode;
            console.log(`📮 Reverse geocode result: "${postcodeLookupResult}"`);
        }
    } catch (err) {
        console.warn("⚠️ postcodes.io reverse geocode failed, falling back to geometry:", err.message);
    }

    // ── Step 2: Try postcode-based zone lookup first ──────────────────────────
    if (postcodeLookupResult) {
        const postcodeZones = await findZoneByPostcode(postcodeLookupResult);
        if (postcodeZones.length === 1) {
            console.log("✅ Zone found via postcode lookup:", postcodeZones[0].name);
            return postcodeZones;
        }
        if (postcodeZones.length > 1) {
            console.log("⚠️ Multiple zones matched by postcode/outcode, choosing nearest zone...");
            return await pickNearestZoneByCentroid(postcodeZones, lat, lng);
        }
        if (postcodeZones.length === 0) {
            console.log("⚠️ No zone matched by postcode, falling back to geometry...");
        }
    }

    // ── Step 3: Fallback — geometry-based lookup (ST_Contains) ───────────────
    console.log("🗺️ Trying geometry-based zone lookup...");
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
        include: zoneInclude,
        attributes: zoneAttributes,
        order: [['id', 'ASC']],
    });
    
    console.log(`Found ${findZone.length} zone(s) via geometry`);
    if (findZone.length > 0) {
        console.log("Zone details:", {
            id: findZone[0].id,
            name: findZone[0].name,
            cityId: findZone[0].city?.id,
            cityName: findZone[0].city?.name,
            countryName: findZone[0].city?.country?.name
        });
    }
    
    // Final safety: if overlapping polygons produce multiple zones,
    // choose nearest zone instead of lowest-id deterministic pick.
    if (findZone.length > 1) {
        console.log(`⚠️ Multiple geometry zones (${findZone.length}) found; choosing nearest zone...`);
        return await pickNearestZoneByCentroid(findZone, lat, lng);
    }

    return findZone;
}

// Address adder function
async function addressAdder(addNew, address, type, userId, addressId, cityId, countryId) {
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
        return dropOffAddressData.id;
    } else {
        return addressId;
    }
}

// Check if time slot booked function
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
                where: {
                    zoneId: zoneId,
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

// Booking event sent check the shops function
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
                required: false,
                include: [
                    {
                        model: agentSelectServices,
                        as: "agentServices",
                        where: {
                            serviceId: {
                                [Op.in]: services.map(service => service.serviceId)
                            }
                        },
                        attributes: ['id'],
                        required: false
                    },
                    {
                        model: bussinessInformation,
                        as: "businessInfo",
                        attributes: ["shopName"],
                        required: false
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
                    as: 'billingDetail',
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
            if (shop.user && shop.user.id) {
                sendEvent(shop.user.id, eventData);
            } else {
                console.warn(`⚠️ Skipping shop ${shop.id} - no associated user found`);
            }
        });
    }
}

/**
 * Customer Order Service
 * Handles all customer order related business logic
 */
class CustomerOrderService {
    _getDatePart(dateValue, fieldName) {
        if (typeof dateValue === 'string' && dateValue.length >= 10) {
            return dateValue.slice(0, 10);
        }

        if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
            const year = dateValue.getFullYear();
            const month = String(dateValue.getMonth() + 1).padStart(2, '0');
            const day = String(dateValue.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        throw new ValidationError(`${fieldName} must be a valid date`);
    }

    _getTimePart(timeValue, fieldName) {
        if (typeof timeValue !== 'string') {
            throw new ValidationError(`${fieldName} must be a valid time`);
        }

        const trimmed = timeValue.trim();
        const validTime = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
        if (!validTime.test(trimmed)) {
            throw new ValidationError(`${fieldName} must be in HH:mm or HH:mm:ss format`);
        }

        return trimmed.length === 5 ? `${trimmed}:00` : trimmed;
    }

    _resolveSourceTimeZone(timeZone) {
        if (!timeZone || typeof timeZone !== 'string') {
            return BUSINESS_TIME_ZONE;
        }

        const normalizedTimeZone = timeZone.trim();
        if (!moment.tz.zone(normalizedTimeZone)) {
            throw new ValidationError(`Unsupported timeZone: ${normalizedTimeZone}`);
        }

        return normalizedTimeZone;
    }

    _getWallClockDateTime(timeZone) {
        const resolvedTimeZone = this._resolveSourceTimeZone(timeZone);
        const wallClock = moment.tz(resolvedTimeZone);
        return {
            date: wallClock.format('YYYY-MM-DD'),
            time: wallClock.format('HH:mm:ss'),
            resolvedTimeZone
        };
    }

    _convertSlotToUtc(dateValue, timeValue, dateFieldName, timeFieldName, timeZone) {
        const datePart = this._getDatePart(dateValue, dateFieldName);
        const timePart = this._getTimePart(timeValue, timeFieldName);
        const sourceTimeZone = this._resolveSourceTimeZone(timeZone);

        const sourceDateTime = moment.tz(
            `${datePart} ${timePart}`,
            'YYYY-MM-DD HH:mm:ss',
            sourceTimeZone
        );

        if (!sourceDateTime.isValid()) {
            throw new ValidationError(`Invalid date/time combination for ${dateFieldName} and ${timeFieldName}`);
        }

        const utcDateTime = sourceDateTime.clone().utc();
        return {
            date: utcDateTime.format('YYYY-MM-DD'),
            time: utcDateTime.format('HH:mm:ss')
        };
    }

    /**
     * Create Booking
     * @param {Object} data - Booking data
     * @param {string} data.collectionDate - Collection date
     * @param {string} data.collectionTimeFrom - Collection time from
     * @param {string} data.collectionTimeTo - Collection time to
     * @param {string} data.driverInstruction - Driver instruction
     * @param {string} data.frequency - Frequency
     * @param {string} data.deliveryDate - Delivery date
     * @param {string} data.deliveryTimeFrom - Delivery time from
     * @param {string} data.deliveryTimeTo - Delivery time to
     * @param {Object} data.pickUpAddress - Pick up address
     * @param {Object} data.dropOffAddress - Drop off address
     * @param {boolean} data.addNewAddress - Add new address flag
     * @param {boolean} data.addNewDropOffAddress - Add new drop off address flag
     * @param {boolean} data.dropOffSamePickUp - Drop off same as pick up flag
     * @param {number} data.dropOffAddressId - Drop off address ID
     * @param {number} data.pickUpAddressId - Pick up address ID
     * @param {Array} data.services - Services array
     * @param {number} data.totalItems - Total items
     * @param {number} data.addressId - Address ID
     * @param {string} data.driverInstructionOptions - Driver instruction options
     * @param {string} data.driverInstructionOptions1 - Driver instruction options 1
     * @param {Array} data.preferencesArray - Preferences array with {preferenceTypeId, preferenceValueId, serviceId?}
     * @param {string} data.setupIntentId - Setup Intent ID (from frontend after confirmation)
     * @param {string} data.paymentMethodId - Payment Method ID (from frontend after confirmation)
     * @param {string} data.stripeCustomerId - Stripe customer ID
     * @param {number} userId - User ID
     * @returns {Object} Booking creation result
     * 
     * NOTE: Both setupIntentId and paymentMethodId are saved.
     * Payment will be charged at Status 4 using paymentMethodId.
     */
    async createBooking(data, userId) {
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
            totalBags,
            sameBagForAllServices,
            addressId,
            driverInstructionOptions,
            driverInstructionOptions1,
            preferencesArray,
            setupIntentId,
            paymentMethodId,
            stripeCustomerId,
            tipAmount,
            timeZone,
            couponCode
        } = data;

        console.log("stripeCustomerId==============>>>", stripeCustomerId);
        console.log("🚀 ~ createBooking ~ req.body:", data);

        // IDEMPOTENCY CHECK: Prevent duplicate bookings with same setupIntentId
        if (setupIntentId) {
            const existingBooking = await booking.findOne({
                where: {
                    setupIntentId: setupIntentId,
                    customerId: userId
                },
                attributes: ['id', 'bookingStatusId', 'paymentConfirmed', 'createdAt']
            });

            if (existingBooking) {
                console.log("⚠️ DUPLICATE DETECTED: Booking already exists with this setupIntentId");
                console.log(`📋 Existing Booking ID: ${existingBooking.id}`);
                console.log(`📅 Created at: ${existingBooking.createdAt}`);
                
                // Return existing booking instead of creating duplicate
                return {
                    message: "Booking already created (duplicate prevented)",
                    data: {
                        bookingId: existingBooking.id,
                        isDuplicate: true,
                        existingBooking: {
                            id: existingBooking.id,
                            bookingStatusId: existingBooking.bookingStatusId,
                            paymentConfirmed: existingBooking.paymentConfirmed,
                            createdAt: existingBooking.createdAt
                        }
                    }
                };
            }
        }

        let userAddressId;
        let userPickUpAddressId;
        let userDropOffAddressId;

        // Find zone information
        let findZone = await findZones(pickUpAddress.lat, pickUpAddress.lng);
        if (!findZone || findZone.length === 0) {
            throw new NotFoundError("No Zone found for these lat,lngs and coordinates");
        }
        let zoneId = findZone[0].id;
        let zoneUpfrontAmount = findZone[0].zoneMinimumAmount;
        let zoneSeviceCharge = findZone[0].serviceCharge;
        let cityId = findZone[0].city.id;
        let countryId = findZone[0].city.country.id;

        console.log("🚀 ~ createBooking ~ findZone:==============================", zoneId);
        console.log("🚀 ~ createBooking ~ findZone:------------------------------", zoneUpfrontAmount);
        console.log("🚀 ~ createBooking ~ findZone:======================+++++++++", zoneSeviceCharge);

        // Handle pick up address
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

        // Handle drop off address
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

        // Generate order tracking ID
        const orderTrackingId = otpGenerator.generate(6, {
            lowerCaseAlphabets: false,
            upperCaseAlphabets: false,
            specialChars: false,
        });

        // Normalize time strings to HH:mm:ss format before saving as-is
        const normalizedCollectionTimeFrom = this._getTimePart(collectionTimeFrom, 'collectionTimeFrom');
        const normalizedCollectionTimeTo   = this._getTimePart(collectionTimeTo,   'collectionTimeTo');
        const normalizedDeliveryTimeFrom   = this._getTimePart(deliveryTimeFrom,   'deliveryTimeFrom');
        const normalizedDeliveryTimeTo     = this._getTimePart(deliveryTimeTo,     'deliveryTimeTo');
        const normalizedCollectionDate     = this._getDatePart(collectionDate,     'collectionDate');
        const normalizedDeliveryDate       = this._getDatePart(deliveryDate,       'deliveryDate');

        const bookingServiceIds = (services || []).map((s) => s.serviceId).filter(Boolean);
        await assertDeliveryMeetsTurnaround(
            service,
            bookingServiceIds,
            normalizedCollectionDate,
            normalizedDeliveryDate,
            ValidationError
        );

        // Create booking
        // NOTE: Both setupIntentId and paymentMethodId are saved from frontend.
        // paymentIntentId will be set at Status 4 when payment is captured.
        const bookingData = await booking.create({
            collectionDate: normalizedCollectionDate,
            collectionTimeFrom: normalizedCollectionTimeFrom,
            collectionTimeTo: normalizedCollectionTimeTo,
            driverInstruction,
            frequency,
            deliveryDate: normalizedDeliveryDate,
            deliveryTimeFrom: normalizedDeliveryTimeFrom,
            deliveryTimeTo: normalizedDeliveryTimeTo,
            customerId: userId,
            bookingStatusId: 1,
            pickupAddresId: userPickUpAddressId,
            dropOffAddressId: userDropOffAddressId,
            totalItems: totalItems || 0,
            totalBags: totalBags != null && totalBags !== "" ? Number(totalBags) : null,
            sameBagForAllServices: sameBagForAllServices !== false,
            paymentConfirmed: false,
            partialPayment: false,
            zoneId: zoneId,
            driverInstructionOptions,
            driverInstructionOptions1,
            subTotal: 0,
            setupIntentId: setupIntentId,
            paymentMethodId: paymentMethodId,
            // paymentIntentId will be set at Status 4 when payment is captured
        });

        // Validate booking preferences. We will create rows after selected services
        // are created so we can attach customerSelectedServiceId.
        const validatedPreferences = [];
        if (preferencesArray && preferencesArray.length > 0) {
            const serviceIds = services.map(s => s.serviceId);

            for (const pref of preferencesArray) {
                const { preferenceTypeId, preferenceValueId, serviceId, parentPreferenceValueId } = pref;

                if (!preferenceTypeId || !preferenceValueId) {
                    throw new ValidationError(
                        "preferenceTypeId and preferenceValueId are required for each preference"
                    );
                }

                if (serviceId) {
                    const serviceExistsInBooking = services.some(s => Number(s.serviceId) === Number(serviceId));
                    if (!serviceExistsInBooking) {
                        throw new ValidationError(`serviceId ${serviceId} in preferences is not part of selected services`);
                    }

                    const servicePreferenceExists = await serviceWithPreferences.findOne({
                        where: {
                            serviceId: serviceId,
                            preferenceTypeId: preferenceTypeId,
                            status: true
                        }
                    });

                    if (!servicePreferenceExists) {
                        throw new ValidationError(
                            `Preference type ${preferenceTypeId} is not available for service ${serviceId}`
                        );
                    }
                } else {
                    const servicePreferenceExists = await serviceWithPreferences.findOne({
                        where: {
                            serviceId: { [Op.in]: serviceIds },
                            preferenceTypeId: preferenceTypeId,
                            status: true
                        }
                    });

                    if (!servicePreferenceExists) {
                        throw new ValidationError(
                            `Preference type ${preferenceTypeId} is not available for any of the selected services`
                        );
                    }
                }

                const preferenceValue = await preferenceValues.findOne({
                    where: {
                        id: preferenceValueId,
                        preferenceTypeId: preferenceTypeId,
                        status: true
                    }
                });

                if (!preferenceValue) {
                    throw new ValidationError(
                        `Preference value ${preferenceValueId} is invalid or does not belong to preference type ${preferenceTypeId}`
                    );
                }

                validatedPreferences.push({
                    bookingId: bookingData.id,
                    serviceId: serviceId || null,
                    preferenceTypeId: preferenceTypeId,
                    preferenceValueId: preferenceValueId,
                    parentPreferenceValueId: parentPreferenceValueId || null,
                    preferenceInstruction: pref.preferenceInstruction || null
                });
            }
        }

        let total = 0;
        let categoryCharge = 0;

        const { date: currentDate, time: currentTime } = this._getWallClockDateTime(timeZone);
        console.log(currentDate);
        console.log(currentTime);

        // Validate coupon early so we fail fast before creating services/billing
        let appliedCouponId = null;
        let discount = 0;

        if (couponCode) {
            // We validate against the zone upfront amount + service charge as the pre-discount total.
            // Actual discount is recorded after booking row is created.
            const preDiscountTotal = parseFloat(
                (parseFloat(zoneUpfrontAmount) + parseFloat(zoneSeviceCharge) + parseFloat(tipAmount || 0)).toFixed(2)
            );
            const couponResult = await couponService.validateCoupon(couponCode, preDiscountTotal, userId);
            appliedCouponId = couponResult.couponId;
            discount = couponResult.discountAmt;
        }

        let serviceCreate = [];
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
                    status: true,
                };
                if (service.categoryId) serviceObj.categoryId = service.categoryId;
                if (service.subCategoryId) serviceObj.categoryId = service.categoryId;
                if (service.categoryCharge) serviceObj.categoryPrice = total;
                if (service.serviceInstruction) serviceObj.serviceInstruction = service.serviceInstruction;
                if (service.items != null && service.items !== '') {
                    serviceObj.items = Number(service.items);
                }

                return serviceObj;
            });
            console.log("🚀 ~ createBooking ~ serviceData:", serviceData);
            serviceCreate = await customerSelectedService.bulkCreate(serviceData);
            console.log("🚀 ~ createBooking ~ serviceCreate:", serviceCreate);

            // Create booking preferences and attach them under each selected service
            // whenever serviceId is provided in preferencesArray.
            if (validatedPreferences.length > 0) {
                const selectedServiceMap = new Map();
                serviceCreate.forEach(selectedService => {
                    const key = Number(selectedService.serviceId);
                    if (!selectedServiceMap.has(key)) {
                        selectedServiceMap.set(key, []);
                    }
                    selectedServiceMap.get(key).push(selectedService.id);
                });

                const bookingPreferencesToCreate = validatedPreferences.map(pref => {
                    let customerSelectedServiceId = null;

                    if (pref.serviceId) {
                        const ids = selectedServiceMap.get(Number(pref.serviceId)) || [];
                        customerSelectedServiceId = ids.length > 0 ? ids[0] : null;
                    }

                    return {
                        bookingId: pref.bookingId,
                        customerSelectedServiceId,
                        preferenceTypeId: pref.preferenceTypeId,
                        preferenceValueId: pref.preferenceValueId,
                        parentPreferenceValueId: pref.parentPreferenceValueId,
                        preferenceInstruction: pref.preferenceInstruction
                    };
                });

                await bookingPreference.bulkCreate(bookingPreferencesToCreate);
            }
        } else if (services.length === 0) {
            throw new ValidationError(
                "Cannot Continue without Selection of Service Types",
                "Select Minimum one Service Type"
            );
        }

        const ordertrackingNumber = `${bookingData.id}-${orderTrackingId}`;
        const upfrontAmount = zoneUpfrontAmount;
        console.log("🚀 ~ createBooking ~ upfrontAmount:", upfrontAmount);

        const fixTimeKey = getOrderExpireTime(40, timeZone);
        console.log("🚀 ~ createBooking ~ fixTimeKey===============+++++++++++++++++++++++++++:", fixTimeKey);

        // Create the billing details
        const parsedUpfront = parseFloat(upfrontAmount) || 0;
        const parsedServiceCharge = parseFloat(zoneSeviceCharge) || 0;
        const parsedTip = parseFloat(tipAmount) || 0;
        const subTotal = parseFloat((parsedUpfront + parsedServiceCharge + parsedTip).toFixed(2));
        const discountedTotal = parseFloat(Math.max(0, subTotal - discount).toFixed(2));

        await billingDetails.create({
            bookingId: bookingData.id,
            upfrontAmount,
            serviceCharge: parsedServiceCharge,
            discount,
            total: discountedTotal,
            paymentStatus: "Pending",
        });

        // Record coupon redemption after billing is created
        if (appliedCouponId && discount > 0) {
            await couponService.recordRedemption(appliedCouponId, userId, bookingData.id, discount);
        }

        await bookingHistory.create({
            date: currentDate,
            time: currentTime,
            bookingId: bookingData.id,
            bookingStatusId: 1,
        });

        let tipCreate = await tip.create({
            bookingId: bookingData.id,
            amount: tipAmount,
        });

        await booking.update(
            {
                orderAmount: total || 0,
                orderTrackId: ordertrackingNumber,
                orderExpireTime: fixTimeKey,
                partialPayment: true,
                subTotal: discountedTotal,
                tipId: tipCreate.id,
            },
            { where: { id: bookingData.id } }
        );

        if (paymentMethodId && stripeCustomerId) {
            await attachPaymentMethodToCustomer(stripeCustomerId, paymentMethodId);
        }

        let bookingId = bookingData.id;
        bookingEventSentCheckTheShops(
            bookingId,
            zoneId,
            collectionDate,
            collectionTimeTo,
            collectionTimeFrom,
            deliveryDate,
            deliveryTimeTo,
            deliveryTimeFrom,
            services
        );

        // Send booking confirmation email (non-blocking)
        try {
            const bookingConfirmationMail = require('../../helper/bookingConfirmationMail');

            // Fetch customer info
            const customerData = await users.findOne({
                where: { id: userId },
                attributes: ['firstName', 'email']
            });

            // Fetch pickup address
            const pickupAddressData = await addressDb.findOne({
                where: { id: userPickUpAddressId },
                attributes: ['streetAddress', 'district', 'postalcode']
            });

            const addressLine = [
                pickupAddressData?.streetAddress,
                pickupAddressData?.district
            ].filter(Boolean).join(', ');

            await bookingConfirmationMail({
                email: customerData?.email || '',
                userName: customerData?.firstName || 'Customer',
                orderNumber: ordertrackingNumber,
                address: addressLine,
                postcode: pickupAddressData?.postalcode || '',
                pickupDate: normalizedCollectionDate,
                pickupTimeFrom: normalizedCollectionTimeFrom,
                pickupTimeTo: normalizedCollectionTimeTo,
                dropoffDate: normalizedDeliveryDate,
                dropoffTimeFrom: normalizedDeliveryTimeFrom,
                dropoffTimeTo: normalizedDeliveryTimeTo,
                upfrontAmount: parsedUpfront,
                currency: '£'
            });

            console.log('✅ Booking confirmation email sent for order:', ordertrackingNumber);
        } catch (emailError) {
            console.error('⚠️ Failed to send booking confirmation email (non-blocking):', emailError.message);
        }

        return {
            message: "Booking Created"
        };
    }

    /**
     * Update Booking Upfront Amount
     * @param {Object} data - Update data
     * @param {string} data.bookingId - Booking ID
     * @param {string} data.IntentId - Payment Intent ID
     * @returns {Object} - Result object
     */
    async updateBookingUpfrontAmount(data) {
        const { bookingId, IntentId } = data;
        if (!bookingId || !IntentId) {
            throw new ValidationError("Booking ID and Intent ID are required");
        }
        const intentDataGet = await getIntent(IntentId);
        if (!intentDataGet) {
            throw new ValidationError("Intent Not Get");
        }
        if (intentDataGet.status === "succeeded") {
            await booking.update(
                {
                    partialPayment: true,
                },
                { where: { id: bookingId } }
            );
        } else {
            throw new ValidationError("Intent Not Succeeded");
        }

        return { message: "Payment Updated Successfully" };
    }

    /**
     * Show Customer On Hold Reason
     * @param {Object} data - Request data
     * @param {string} data.bookingId - Booking ID
     * @returns {Object} - Result object with customer option data
     */
    async onHoldCustomerShow(data) {
        const { bookingId } = data;
        if (!bookingId) {
            throw new ValidationError("Booking ID is required");
        }
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
        console.log("🚀 ~ onHoldCustomerShow ~ userFound:", userFound.customer.id);
        if (!userFound) {
            throw new NotFoundError("No User Found");
        }
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
        console.log("🚀 ~ onHoldCustomerShow ~ optionIdFound:", optionIdFound);
        if (!optionIdFound) {
            throw new NotFoundError("No Option ID Found");
        }
        const customerOptionFound = await onHoldCustomerOption.findOne({
            where: {
                onHoldOptionId: optionIdFound.onHoldOptionId,
            },
            attributes: ["id", "option", "title", "conformationText", "notConfirmText"],
        });
        if (!customerOptionFound) {
            throw new NotFoundError("No Customer Option Found");
        }
        return {
            message: "Customer On Hold Response Show",
            data: customerOptionFound
        };
    }

    /**
     * Update Customer Response for On Hold Booking
     * @param {Object} data - Request data
     * @param {string} data.bookingId - Booking ID
     * @param {boolean} data.customerResponse - Customer response (true/false)
     * @returns {Object} - Result object
     */
    async customerResponseUpdate(data) {
        const { bookingId, customerResponse, timeZone } = data;

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
            "🚀 ~ customerResponseUpdate ~ bookingFind:",
            bookingFind.laundryShop.user.id
        );
        const userId = bookingFind.laundryShop.user.id;

        await OnHoldConfirmation.update(
            {
                customerResponse: customerResponse,
            },
            { where: { bookingId: bookingId } }
        );

        const { date: currentDate, time: currentTime } = this._getWallClockDateTime(timeZone);

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

        return { message: "Customer Response" };
    }

    /**
     * Get All Customer Bookings
     * @param {Object} data - Request data
     * @param {string} data.userId - User ID
     * @returns {Object} - Result object with bookings data
     */
    async allBookings(data) {
        const { userId } = data;

        const findAllBooking = await booking.findAll({
            where: {
                customerId: userId,
            },
            include: [
                {
                    model: bookingStatus,
                    attributes: ["title", "description"],
                },
            ],
            attributes: ["id", "orderAmount", "orderTrackId", "collectionDate", "collectionTimeFrom", "collectionTimeTo", "deliveryDate", "deliveryTimeFrom", "deliveryTimeTo", "driverInstructionOptions", "driverInstructionOptions1"],
        });
        if (!findAllBooking || findAllBooking.length === 0) {
            throw new NotFoundError("No Bookings Found");
        }

        return {
            message: "Customer All Bookings",
            data: findAllBooking
        };
    }

    /**
     * Get Booking Details by ID
     * @param {Object} data - Request data
     * @param {string} data.bookingId - Booking ID (optional)
     * @param {string} data.orderTrackId - Order Track ID (optional)
     * @returns {Object} - Result object with booking details
     */
    async bookingDetailsById(data) {
        const { bookingId, orderTrackId } = data;

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
                        "id",
                        "title",
                        "customAddressTitle",
                        "hotelName",
                        "apartmentNumber",
                        "floor",
                        "streetAddress",
                        "district",
                        "province",
                        "postalcode",
                        "lat",
                        "lng",
                        "addressType",
                        "isDefault",
                    ],
                },
                {
                    model: addressDb,
                    as: "dropOffAddress",
                    attributes: [
                        "id",
                        "title",
                        "customAddressTitle",
                        "hotelName",
                        "apartmentNumber",
                        "floor",
                        "streetAddress",
                        "district",
                        "province",
                        "postalcode",
                        "lat",
                        "lng",
                        "addressType",
                        "isDefault",
                    ],
                },
                {
                    model: customerSelectedService,
                    where:{
                        status:true
                    },
                    required: false,
                    attributes: [
                        "date",
                        "time",
                        "categoryprice",
                        "categoryId",
                        "serviceId",
                        "subCategoryId",
                        "items",
                        "serviceInstruction",
                    ],
                    include: [
                        {
                            model: service,
                            attributes: ["id", "name", "status", "image"],
                            required: false,
                            paranoid: false,
                        },
                        {
                            model: categories,
                            attributes: ["id", "name", "status", "image", "description"],
                            required: false,
                            paranoid: false,
                        },
                        {
                            model: subCategories,
                            attributes: ["id", "name", "status", "price", "unitCount"],
                            required: false,
                            paranoid: false,
                        },
                        {
                            model: customerSelectedServiceAddOn,
                            as: 'addOns',
                            required: false,
                            attributes: ['id', 'addOnServiceId', 'price'],
                            include: [
                                {
                                    model: addOnServices,
                                    as: 'addOnService',
                                    attributes: ['id', 'name', 'price'],
                                    required: false,
                                },
                            ],
                        },
                        {
                            model: bookingPreference,
                            as: 'selectedServicePreferences',
                            required: false,
                            attributes: [
                                "id",
                                "customerSelectedServiceId",
                                "preferenceTypeId",
                                "preferenceValueId",
                                "parentPreferenceValueId",
                                "preferenceInstruction",
                            ],
                            include: [
                                {
                                    model: preferenceTypes,
                                    attributes: ["id", "name"],
                                    required: false,
                                },
                                {
                                    model: preferenceValues,
                                    attributes: ["id", "value"],
                                    required: false,
                                },
                            ],
                        },
                    ],
                },
                {
                    model: bookingPreference,
                    as: 'bookingPreferences',
                    required: false,
                    attributes: [
                        "id",
                        "customerSelectedServiceId",
                        "preferenceTypeId",
                        "preferenceValueId",
                        "parentPreferenceValueId",
                        "preferenceInstruction",
                    ],
                    include: [
                        {
                            model: preferenceTypes,
                            attributes: ["id", "name"],
                            required: false,
                        },
                        {
                            model: preferenceValues,
                            attributes: ["id", "value"],
                            required: false,
                        },
                    ],
                },
                {
                    model: bookingStatus,
                    attributes: ["id","title", "description"],
                },
                {
                    model: bookingHistory,
                    attributes: ["date", "time"],
                    include: [
                        {
                            model: bookingStatus,
                            attributes: ["id","title", "description"],
                        },
                    ],
                },
                {
                    model: zone,
                    attributes: ["id","name","zoneMinimumAmount","serviceCharge"],
                    include: [
                        {
                            model: units,
                            as: 'currencyUnitZ',
                            attributes: ["id", "name", "symbol", "type"],
                        }
                    ]
                },
                {
                    model: proofOfDeliveries,
                    attributes: ["id", "imgUpload", "noOfItems", "note", "deliveryType", "createdAt", "updatedAt"],
                },
                {
                    model: tip,
                    as: 'tips',
                    attributes: ["id", "amount"],
                    required: false,
                },
                {
                    model: billingDetails,
                    as: 'billingDetail',
                    attributes: ["id", "upfrontAmount", "discount", "total", "zoneAdminCommission", "serviceCharge", "categoryCharge", "pickupDriverEarning", "deliveryDriverEarning", "paymentStatus"],
                    required: false,
                },
                {
                    model: policy,
                    as: "cancellationPolicyBookings",
                    attributes: ["id", "name", "type", "isActive", "isDefault", "description"],
                    required: false,
                    include: [
                        {
                            model: cancellationPolicyConfig,
                            as: "cancellationConfig",
                            attributes: [
                                "id",
                                "isActive",
                                "prePickupAbsoluteCurrency",
                                "prePickupAbsoluteAmount",
                                "prePickupPercentage",
                                "prePickupFreeChargeWindowMinutes",
                                "prePickupFirstCancellationLeniency",
                                "unprocessedAbsoluteCurrency",
                                "unprocessedAbsoluteAmount",
                                "unprocessedPercentage",
                                "unprocessedAfterPickupMinutes",
                                "unprocessedOrderValuePercentage",
                                "allowCancelUnprocessed",
                                "courtesyWindowDays",
                                "courtesyCapAmount",
                                "courtesyCount",
                                "customerLeniencyEnabled"
                            ],
                            required: false
                        }
                    ]
                },
                {
                    model: policy,
                    as: "noShowPolicyBookings",
                    attributes: ["id", "name", "type", "isActive", "isDefault", "description"],
                    required: false,
                    include: [
                        {
                            model: noShowPolicyConfig,
                            as: 'noShowConfig',
                            attributes: [
                                "id",
                                "enableForPickup",
                                "enableForDelivery",
                                "feeType",
                                "currency",
                                "pickupNoShowFee",
                                "deliveryNoShowFee",
                                "storageFeePerDay",
                                "percentageFee",
                                "graceMinutesOnSite",
                                "driverLateSLA",
                                "autoForgiveFirstNoShow",
                                "autoForgiveCount",
                                "autoForgivePeriod",
                                "requirePaymentAfterCap",
                                "perCustomerCap",
                                "capWindowDays",
                                "absoluteWaiverAmount",
                                "percentageWaiverAmount"
                            ],
                            required: false
                        }
                    ]
                }
            ],
        });
        if (!bookingFind) {
            throw new NotFoundError("No Booking Found");
        }

        const bookingPlain = bookingFind.toJSON ? bookingFind.toJSON() : bookingFind;

        // Ensure add-ons are always populated for selected services.
        // Some Sequelize nested include combinations can return empty hasMany arrays
        // despite rows existing, so we hydrate add-ons explicitly by selected service IDs.
        const selectedServices = Array.isArray(bookingPlain.customerSelectedServices)
            ? bookingPlain.customerSelectedServices
            : [];
        const selectedServiceIds = selectedServices.map(s => s.id).filter(Boolean);

        if (selectedServiceIds.length > 0) {
            const addOnRows = await customerSelectedServiceAddOn.findAll({
                where: { customerSelectedServiceId: { [Op.in]: selectedServiceIds } },
                attributes: ['id', 'customerSelectedServiceId', 'addOnServiceId', 'price', 'items'],
                include: [
                    {
                        model: addOnServices,
                        as: 'addOnService',
                        attributes: ['id', 'name', 'price'],
                        required: false,
                    },
                ],
                order: [['id', 'ASC']]
            });

            const addOnsByServiceId = {};
            for (const row of addOnRows) {
                const plain = row.toJSON ? row.toJSON() : row;
                const key = plain.customerSelectedServiceId;
                if (!addOnsByServiceId[key]) {
                    addOnsByServiceId[key] = [];
                }
                const unitPrice = parseFloat(plain.price) || 0;
                const items = parseInt(plain.items, 10) > 0 ? parseInt(plain.items, 10) : 1;
                addOnsByServiceId[key].push({
                    id: plain.id,
                    addOnServiceId: plain.addOnServiceId,
                    price: plain.price,
                    items,
                    lineTotal: parseFloat((unitPrice * items).toFixed(2)),
                    addOnService: plain.addOnService || null
                });
            }

            bookingPlain.customerSelectedServices = selectedServices.map(serviceItem => ({
                ...serviceItem,
                addOns: addOnsByServiceId[serviceItem.id] || []
            }));
        }

        const cancellationPolicyRaw = bookingPlain.cancellationPolicyBookings;
        let cancellationPolicy = null;

        if (cancellationPolicyRaw && cancellationPolicyRaw.cancellationConfig) {
            const config = cancellationPolicyRaw.cancellationConfig;
            cancellationPolicy = {
                id: cancellationPolicyRaw.id,
                name: cancellationPolicyRaw.name,
                description: cancellationPolicyRaw.description || null,
                freeCancellationWindowMinutes: config.prePickupFreeChargeWindowMinutes ?? null,
                firstCancellationFree: config.prePickupFirstCancellationLeniency ?? false,
                prePickupChargeAmount: config.prePickupAbsoluteAmount ?? null,
                prePickupChargeCurrency: config.prePickupAbsoluteCurrency ?? null,
                prePickupChargePercentage: config.prePickupPercentage ?? null,
                unprocessedChargeAmount: config.unprocessedAbsoluteAmount ?? null,
                unprocessedChargeCurrency: config.unprocessedAbsoluteCurrency ?? null,
                unprocessedChargePercentage: config.unprocessedPercentage ?? null,
                unprocessedAfterPickupMinutes: config.unprocessedAfterPickupMinutes ?? null,
                unprocessedOrderValuePercentage: config.unprocessedOrderValuePercentage ?? null,
                allowCancelUnprocessed: config.allowCancelUnprocessed ?? true,
                courtesyWindowDays: config.courtesyWindowDays ?? null,
                courtesyCount: config.courtesyCount ?? null,
                courtesyCapAmount: config.courtesyCapAmount ?? null,
                customerLeniencyEnabled: config.customerLeniencyEnabled ?? true
            };
        }

        const noShowPolicyRaw = bookingPlain.noShowPolicyBookings;
        let noShowPolicy = null;

        if (noShowPolicyRaw && noShowPolicyRaw.noShowConfig) {
            const config = noShowPolicyRaw.noShowConfig;
            noShowPolicy = {
                id: noShowPolicyRaw.id,
                name: noShowPolicyRaw.name,
                description: noShowPolicyRaw.description || null,
                enableForPickup: config.enableForPickup ?? true,
                enableForDelivery: config.enableForDelivery ?? true,
                feeType: config.feeType ?? null,
                currency: config.currency ?? null,
                pickupNoShowFee: config.pickupNoShowFee ?? null,
                deliveryNoShowFee: config.deliveryNoShowFee ?? null,
                storageFeePerDay: config.storageFeePerDay ?? null,
                percentageFee: config.percentageFee ?? null,
                graceMinutesOnSite: config.graceMinutesOnSite ?? null,
                driverLateSLA: config.driverLateSLA ?? null,
                autoForgiveFirstNoShow: config.autoForgiveFirstNoShow ?? true,
                autoForgiveCount: config.autoForgiveCount ?? null,
                autoForgivePeriod: config.autoForgivePeriod ?? null,
                requirePaymentAfterCap: config.requirePaymentAfterCap ?? true,
                perCustomerCap: config.perCustomerCap ?? null,
                capWindowDays: config.capWindowDays ?? null,
                absoluteWaiverAmount: config.absoluteWaiverAmount ?? null,
                percentageWaiverAmount: config.percentageWaiverAmount ?? null
            };
        }

        // Fetch saved card details from Stripe using the stored paymentMethodId
        let cardDetails = null;
        if (bookingPlain.paymentMethodId) {
            try {
                const paymentMethod = await paymentIntentGet(bookingPlain.paymentMethodId);
                if (paymentMethod && paymentMethod.card) {
                    cardDetails = {
                        brand: paymentMethod.card.brand,
                        last4: paymentMethod.card.last4,
                        expMonth: paymentMethod.card.exp_month,
                        expYear: paymentMethod.card.exp_year,
                        funding: paymentMethod.card.funding,
                        cardholderName: paymentMethod.billing_details?.name || null,
                    };
                }
            } catch (_) {
                // Non-blocking — card details are optional
            }
        }

        const resultData = {
            ...bookingPlain,
            cardDetails,
            cancellationPolicy,
            noShowPolicy
        };
        delete resultData.cancellationPolicyBookings;
        delete resultData.noShowPolicyBookings;

        return {
            message: "Customer Order Details Fetched",
            data: resultData
        };
    }

    /**
     * Get All Services
     * @returns {Object} - Result object with services data
     */
    async allServices() {
        const serviceData = await service.findAll({
            order: [['sortOrder', 'ASC']]
        });

        if (!serviceData || serviceData.length === 0) {
            throw new NotFoundError("No Services Found");
        }

        return {
            message: "All Services",
            data: { serviceData }
        };
    }

    /**
     * Get Service Detail by ID
     * @param {Object} data - Request data
     * @returns {Object} - Result object with service details
     */
    async serviceDetail() {
        const activeServices = await service.findAll({
            where: { status: true },
            attributes: [
                'id',
                'name',
                'status',
                'image',
                'description',
                'timeRequired',
                'pricingBasis',
                'numberOfBags',
                'numberOfItems',
            ],
            order: [['sortOrder', 'ASC']],
        });

        if (!activeServices || activeServices.length === 0) {
            throw new NotFoundError('No Service Details Found');
        }

        const result = [];

        for (const svc of activeServices) {
            const serviceCategoriesData =
                await serviceManagementService.getServiceCategoriesDataForService(
                    svc.id
                );

            if (!serviceCategoriesData.length) {
                continue;
            }

            result.push({
                serviceId: svc.id,
                service: {
                    id: svc.id,
                    name: svc.name || '',
                    status: svc.status,
                    image: svc.image || null,
                    description: svc.description || null,
                    turnAroundTime: svc.timeRequired || null,
                    pricingBasis: svc.pricingBasis || null,
                    numberOfBags: Boolean(svc.numberOfBags),
                    numberOfItems: Boolean(svc.numberOfItems),
                },
                categories: serviceCategoriesData.map((row) => ({
                    categoryId: row.categoryId,
                    category: {
                        id: row.category.id,
                        name: row.category.name || '',
                        status: true,
                        image: null,
                        description: row.category.description || null,
                    },
                    subCategories: (row.category.subCategories || []).map(
                        (subCat) => {
                            const plainSubCat = subCat.toJSON
                                ? subCat.toJSON()
                                : subCat;
                            return {
                                id: plainSubCat.id,
                                name: plainSubCat.name,
                                status: plainSubCat.status,
                                price: plainSubCat.price,
                                unitCount: plainSubCat.unitCount ?? null,
                            };
                        }
                    ),
                })),
            });
        }

        if (result.length === 0) {
            throw new NotFoundError('No Service Details Found');
        }

        return {
            message: 'Service Details',
            data: { serviceData: result },
        };
    }

    /**
     * Get Customer Addresses
     * @param {Object} data - Request data
     * @param {string} data.userId - User ID
     * @returns {Object} - Result object with customer addresses
     */
    async customerAddresses(data) {
        const { userId } = data;

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
                "addressType",
                "lat",
                "lng"
            ],
        });

        if (!customerAddresses || customerAddresses.length === 0) {
            throw new NotFoundError("No Customer Addresses Found");
        }

        return {
            message: "Customer Addresses",
            data: customerAddresses
        };
    }

    /**
     * Fetch Zone and Charges
     * @param {Object} data - Request data
     * @param {string} data.lat - Latitude
     * @param {string} data.lng - Longitude
     * @returns {Object} - Result object with zone and charge information
     */
    async fetchZoneAndCharges(data) {
        const { lat, lng } = data;

        console.log("=== Fetch Zone and Charges ===");
        console.log("Coordinates:", { lat, lng });

        if (!lat || !lng) {
            throw new ValidationError("Latitude and Longitude are required");
        }

        // Validate coordinates
        const numLat = parseFloat(lat);
        const numLng = parseFloat(lng);
        
        if (isNaN(numLat) || isNaN(numLng)) {
            throw new ValidationError("Invalid latitude or longitude values");
        }

        if (numLat < -90 || numLat > 90) {
            throw new ValidationError("Latitude must be between -90 and 90");
        }

        if (numLng < -180 || numLng > 180) {
            throw new ValidationError("Longitude must be between -180 and 180");
        }

        const zoneData = await findZones(numLat, numLng);

        if (!zoneData || zoneData.length === 0) {
            throw new NotFoundError(
                "No active zone found for the provided coordinates. Please ensure:\n" +
                "1. The zone exists and status is set to true\n" +
                "2. The zone's city and country are not deleted\n" +
                "3. The coordinates are within the zone's polygon boundaries"
            );
        }

        let zoneId = zoneData[0].id;
        let zoneName = zoneData[0].name;
        let zoneUpfrontAmount = zoneData[0].zoneMinimumAmount;
        let zoneSeviceCharge = zoneData[0].serviceCharge;
        let cityId = zoneData[0].city.id;
        let cityName = zoneData[0].city.name;
        let countryId = zoneData[0].city.country.id;
        let countryName = zoneData[0].city.country.name;
        let currencyUnitId = zoneData[0].currencyUnitId;
        let currencyUnit = zoneData[0].currencyUnitZ;

        console.log("Zone found successfully:", { zoneId, zoneName, cityName, countryName, currency: currencyUnit?.name });

        return {
            message: "Zone and Charges",
            data: { 
                zoneId, 
                zoneName,
                zoneUpfrontAmount, 
                zoneSeviceCharge, 
                cityId,
                cityName,
                countryId,
                countryName,
                currencyUnitId,
                currency: currencyUnit ? {
                    id: currencyUnit.id,
                    name: currencyUnit.name,
                    symbol: currencyUnit.symbol
                } : null
            }
        };
    }

    /**
     * Create Setup Intent Using Stripe
     * @param {Object} data - Request data
     * @param {string} data.customerId - Stripe customer ID
     * @returns {Object} - Result object with setup intent data
     * 
     * NOTE: Setup Intent is used to save payment method without charging.
     * Payment will be charged later when booking reaches laundry shop (status 8).
     */
    async createIntentUsingStripe(data) {
        const { customerId } = data;

        // Detailed validation
        if (!customerId) {
            throw new ValidationError("Customer ID is required");
        }

        console.log("Creating setup intent for customer:", customerId);

        // Create Setup Intent instead of Payment Intent
        const setupIntent = await createSetupIntent(customerId);
        console.log("🚀 ~ createIntentUsingStripe ~ setup intent created:", setupIntent.id);

        let intentData = {
            setupIntentId: setupIntent.id,
            clientSecret: setupIntent.client_secret,
            customerId: customerId,
            status: setupIntent.status
        };

        return {
            message: "Setup Intent Created - Card will be saved without charging",
            data: intentData
        };
    }

    /**
     * Get On-Hold Bookings
     * @param {Object} data - Request data
     * @param {string} data.bookingId - Booking ID
     * @returns {Object} - Result object with on-hold bookings data
     */
    async getOnHoldBookings(data) {
        const { bookingId } = data;

        if (!bookingId) {
            throw new ValidationError("Booking ID is required");
        }

        const onHoldBookings = await OnHoldConfirmation.findAll({
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
                    attributes: ['id', 'name', 'price', 'unitCount']
                }
            ],
            attributes: ['id', 'onHoldImg', 'description', 'customerResponse']
        });

        if (!onHoldBookings || onHoldBookings.length === 0) {
            throw new NotFoundError("No on-hold bookings found");
        }

        return {
            message: "On-hold bookings retrieved successfully",
            data: { onHoldBookings }
        };
    }

    /**
     * Update Customer Response for On Hold Booking
     * @param {Object} data - Request data
     * @param {Array} data.responses - Array of response objects
     * @param {string} data.bookingId - Booking ID
     * @returns {Object} - Result object with updated responses
     */
    async updateCustomerResponseForOnHoldBooking(data) {
        const { responses, bookingId, timeZone } = data;

        if (!Number.isInteger(bookingId)) {
            throw new ValidationError("bookingId must be an integer");
        }

        if (!Array.isArray(responses) || responses.length === 0) {
            throw new ValidationError("responses must be a non-empty array");
        }

        // Validate all items first
        for (const r of responses) {
            const { customerResponse, onHoldId, note } = r ?? {};
            if (typeof customerResponse !== "boolean") {
                throw new ValidationError("customerResponse must be boolean for each response");
            }
            if (!Number.isInteger(onHoldId)) {
                throw new ValidationError("onHoldId must be an integer for each response");
            }
            if (note != null && typeof note !== "string") {
                throw new ValidationError("note must be a string when provided");
            }
        }

        const updatedResponses = [];

        for (const { customerResponse, onHoldId, note } of responses) {
            const onHoldBooking = await OnHoldConfirmation.findOne({
                where: { id: onHoldId, bookingId }
            });

            if (!onHoldBooking) {
                throw new NotFoundError(`On-hold booking not found for onHoldId: ${onHoldId}`);
            }

            onHoldBooking.customerResponse = customerResponse;   // can be true or false
            onHoldBooking.responseConformation = true;

            const trimmedNote = typeof note === "string" ? note.trim() : "";
            if (trimmedNote) {
                const customerNote = `Customer: ${trimmedNote}`;
                onHoldBooking.description = onHoldBooking.description
                    ? `${onHoldBooking.description}\n${customerNote}`
                    : customerNote;
            }

            await onHoldBooking.save();

            updatedResponses.push({
                id: onHoldBooking.id,
                bookingId: onHoldBooking.bookingId,
                customerResponse: onHoldBooking.customerResponse,
                updatedAt: onHoldBooking.updatedAt
            });
        }

        // Mark booking as customer-responded so agentIssueResolved can proceed.
        const { date: currentDate, time: currentTime } = this._getWallClockDateTime(timeZone);

        await booking.update(
            { bookingStatusId: 22 },
            { where: { id: bookingId } }
        );

        await bookingHistory.create({
            bookingId,
            bookingStatusId: 22,
            date: currentDate,
            time: currentTime
        });

        return {
            message: "Customer responses updated successfully",
            data: {
                updatedResponses,
                bookingStatusId: 22
            }
        };
    }

    /**
     * Get On-Hold Bookings for Customer
     * @param {Object} data - Request data
     * @param {string} data.customerId - Customer ID
     * @returns {Object} - Result object with on-hold bookings data
     */
    async getOnHoldBookingsForCustomer(data) {
        const { customerId } = data;

        if (!customerId) {
            throw new ValidationError("Customer ID is required");
        }

        const onHoldBookings = await booking.findAll({
            where: {
                customerId: customerId,
                bookingStatusId: 18,
            },
            include: [
                {
                    model: OnHoldConfirmation,
                    required: false,
                    attributes: ['id', 'onHoldImg', 'description', 'customerResponse']
                }
            ],
            attributes: ["id", "orderAmount", "orderTrackId", "collectionDate", "collectionTimeFrom", "collectionTimeTo", "deliveryDate", "deliveryTimeFrom", "deliveryTimeTo", "driverInstructionOptions", "driverInstructionOptions1"],
        });

        if (!onHoldBookings || onHoldBookings.length === 0) {
            throw new NotFoundError("No on-hold bookings found for this customer");
        }

        return {
            message: "On-hold bookings retrieved successfully",
            data: { onHoldBookings }
        };
    }

    /**
     * Get Home Screen Config
     * Returns the 4 info cards shown on the customer home screen:
     * Delivery window, Minimum order amount, Service fee, No-show fee
     * @returns {Object} homeConfig data
     */
    async getHomeConfig(data = {}) {
        const { lat, lng } = data;

        if (lat === undefined || lat === null || lng === undefined || lng === null) {
            throw new ValidationError("Latitude and Longitude are required");
        }

        const parsedLat = parseFloat(lat);
        const parsedLng = parseFloat(lng);
        if (Number.isNaN(parsedLat) || Number.isNaN(parsedLng)) {
            throw new ValidationError("Latitude and Longitude must be valid numbers");
        }

        // Resolve zone from the given customer coordinates
        const matchedZones = await findZones(parsedLat, parsedLng);
        const activeZone = Array.isArray(matchedZones) ? matchedZones[0] : matchedZones;
        if (!activeZone) {
            throw new NotFoundError("No active zone found for the provided coordinates");
        }

        const activeZoneId = activeZone?.id ?? null;
        const now = new Date();

        const zonePolicyWhere = (type) => ({
            type,
            isActive: true,
            ...(activeZoneId !== null ? { zoneId: activeZoneId } : {}),
            [Op.and]: [
                {
                    [Op.or]: [
                        { effectiveFrom: null },
                        { effectiveFrom: { [Op.lte]: now } }
                    ]
                },
                {
                    [Op.or]: [
                        { effectiveTo: null },
                        { effectiveTo: { [Op.gte]: now } }
                    ]
                }
            ]
        });

        const [defaultNoShowPolicy, defaultCancellationPolicy] = await Promise.all([
            policy.findOne({
                where: zonePolicyWhere('no_show'),
                attributes: ['id', 'name'],
                include: [{
                    model: noShowPolicyConfig,
                    as: 'noShowConfig',
                    attributes: ['pickupNoShowFee', 'deliveryNoShowFee', 'useUnifiedFee', 'currency']
                }],
                order: [['isDefault', 'DESC'], ['effectiveFrom', 'DESC'], ['createdAt', 'DESC']]
            }),
            policy.findOne({
                where: zonePolicyWhere('cancellation'),
                attributes: ['id', 'name'],
                include: [{
                    model: cancellationPolicyConfig,
                    as: 'cancellationConfig',
                    attributes: ['prePickupAbsoluteAmount', 'prePickupAbsoluteCurrency', 'prePickupPercentage']
                }],
                order: [['isDefault', 'DESC'], ['effectiveFrom', 'DESC'], ['createdAt', 'DESC']]
            })
        ]);

        const currency = activeZone?.currencyUnitZ?.symbol || '$';
        const minOrder = activeZone?.zoneMinimumAmount ?? null;
        const serviceFee = activeZone?.serviceCharge ?? null;

        let noShowFee = null;
        if (defaultNoShowPolicy?.noShowConfig) {
            const cfg = defaultNoShowPolicy.noShowConfig;
            noShowFee = cfg.useUnifiedFee ? cfg.pickupNoShowFee : cfg.pickupNoShowFee;
        }

        const cancellationCfg = defaultCancellationPolicy?.cancellationConfig;
        const cancellationFee = cancellationCfg?.prePickupAbsoluteAmount ?? null;
        const cancellationCurrency = cancellationCfg?.prePickupAbsoluteCurrency || 'USD';

        return {
            message: "Home config fetched successfully",
            data: {
                delivery: {
                    label: "Delivery",
                    value: "Free 24h",
                    isFree: true,
                    windowHours: 24
                },
                minOrder: {
                    label: "Min. Order",
                    value: minOrder,
                    currency
                },
                serviceFee: {
                    label: "Service Fee",
                    value: serviceFee,
                    currency
                },
                noShowFee: {
                    label: "No-Show Fee",
                    value: noShowFee,
                    currency: defaultNoShowPolicy?.noShowConfig?.currency || 'USD'
                },
                cancellationFee: {
                    label: "Cancellation Fee",
                    value: cancellationFee,
                    currency: cancellationCurrency
                },
                zone: {
                    id: activeZone.id,
                    name: activeZone.name
                }
            }
        };
    }

    /**
    * ALl ORder Status
    * @param {Object} data - Request data
    * @returns {Object} - Result object with all order status
    */
    async allOrderStatus() {
        const allOrderStatuses = await bookingStatus.findAll({
            attributes:['id','title','description']
        });
        if (!allOrderStatuses || allOrderStatuses.length === 0) {
            throw new NotFoundError("No Order Statuses Found");
        }

        return {
            message: "All Order Statuses",
            data: allOrderStatuses
        };
    }
}

module.exports = new CustomerOrderService();

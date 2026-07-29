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
    preferencesServiceName,
    tip,
    customerSelectedServiceAddOn,
    customerSelectedServiceLine,
    addOnServices,
    bookingPreference,
    preferenceTypes,
    preferenceValues
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
const momentTz = require("moment-timezone");
const axios = require("axios");
const {
    getLineQuantity,
    getUnitCategoryCharge,
    getLineSubtotal,
    getAddOnRowSubtotal,
    serviceLineHasAddOnPayload,
    replaceAddOnsForServiceLine,
    sumActiveBookingServicesSubtotal,
} = require("../../utils/invoiceLineTotals");
const {
    wallClockNow,
    resolveBookingTimeZone,
    BOOKING_ACCEPT_WINDOW_MINUTES,
    isBookingAcceptWindowOpen,
    getAcceptWindowMinutesRemaining,
    formatOrderExpireTimeForApi,
} = require("../../utils/bookingTimeZone");
const { getAcceptWindowAnchor } = require("../../utils/bookingAgentWindow");
const {
    markAgentOnline,
    isAgentOnline,
} = require("../../utils/agentOnlineStatus");
const {
    isShopOpenNow,
    isPlatformOpenNow,
    isAnyShopOpenInZone,
    findTodayWorkingHoursRow,
    getWallClockContext,
    isPickupWithinShopWorkingHours,
} = require("../../utils/shopWorkingHours");

/** Same default as customer booking / reschedule services (IANA). */
const AGENT_BUSINESS_TIME_ZONE = "Europe/London";

/**
 * Wall-clock date/time for agent actions (invoice lines, history).
 * Pass timeZone or clientTimeZone from the app (e.g. Asia/Karachi) so stored times match the user.
 */
function agentWallClockDateTime(timeZone, clientTimeZone) {
    const candidate = timeZone || clientTimeZone;
    const tz =
        candidate && typeof candidate === "string" && momentTz.tz.zone(candidate.trim())
            ? candidate.trim()
            : AGENT_BUSINESS_TIME_ZONE;
    const m = momentTz.tz(tz);
    return {
        date: m.format("YYYY-MM-DD"),
        time: m.format("HH:mm:ss"),
    };
}

/** Optional non-negative integer from multipart fields (empty/missing → undefined). */
function parseOptionalProofCount(value, fieldName) {
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    if (trimmed === "") return undefined;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
        throw new ValidationError(`${fieldName} must be a valid non-negative number`);
    }
    return Math.trunc(n);
}

function normalizeProofDeliveryType(value) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase().replace(/[\s_-]/g, "");
    if (lower === "pickup") return "pickUp";
    if (lower === "dropoff" || lower === "delivery") return "dropOff";
    if (trimmed === "pickUp" || trimmed === "dropOff") return trimmed;
    return null;
}

const { map } = require("../../routes/driver");
const { resolveObjectURL } = require("buffer");
const { confirmAndCapturePayment, chargeOffSession, capturePaymentIntent, getIntent } = require("../stripe");
const { getPickupChargeAmount } = require("../../utils/invoicePrepaidDeduction");
const { buildStripeChargePresentation } = require("../../utils/stripePaymentMetadata");
const {
    resolveBalancePaymentMethod,
    normalizePaymentType,
    buildCollectPaymentFlags,
} = require("../../utils/invoicePaymentSummary");
const ResponseHelper = require('../../utils/responseHelper');
const invoiceManagementService = require("../../services/Agent/invoiceManagementService");
const agentServiceManagementService = require("../../services/Agent/serviceManagementService");
const { sendNotification } = require("../../utils/notification");
const {
    assertBookingNotCancelledForAgent,
} = require("../../utils/assertBookingNotCancelledForAgent");
const { redactCustomerPhone } = require("../../utils/maskPhone");
const customerPostcodeService = require('../../services/Customer/customerPostcodeService');
const { getPostcodeActorId } = require('../../utils/postcodeActor');
const activePoliciesService = require('../../services/Admin/activePoliciesService');
const addOnServicesService = require('../../services/Admin/addOnServicesService');
const agentRolePermissionService = require('../../services/Agent/rolePermissionService');
const agentEmployeeManagementService = require('../../services/Agent/employeeManagementService');
const agentBookingDeclineService = require('../../services/Agent/agentBookingDeclineService');
const agentOrderManagementService = require('../../services/Agent/orderManagementService');
const agentWalletService = require('../../services/Agent/agentWalletService');
const agentSettlementService = require('../../services/Agent/agentSettlementService');
const agentWithdrawalService = require('../../services/Agent/agentWithdrawalService');

async function tryCreditAgentWallet(bookingId, options = {}) {
    try {
        const result = await agentWalletService.creditAgentForPaidBooking(bookingId, options);
        if (result.credited) {
            console.log(
                `[agentWallet] Credited booking ${bookingId}: ${result.amount}`
            );
        }
        return result;
    } catch (err) {
        console.error(
            `[agentWallet] Credit failed for booking ${bookingId}:`,
            err.message
        );
        return { credited: false, reason: err.message };
    }
}
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

    const agentUser = await users.findByPk(agentId, {
        attributes: ["id", "ianaTimeZone"],
    });

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
                attributes: ["id", "name", "shortName", "ianaTimeZone"],
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

    const plain = agentAddress.get({ plain: true });

    const agentTz = agentUser?.ianaTimeZone || null;
    const shopTz = plain.country?.ianaTimeZone || null;

    return ResponseHelper.success(res, "Agent Address Retrieved Successfully", {
        ...plain,
        ianaTimeZone: agentTz,
        shopOperationalTimeZone: shopTz,
    });
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
        attributes: ["id", "ianaTimeZone"],
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
            {
                model: bussinessInformation,
                as: 'agentInfo',
                attributes: ['id', 'connectAccountId', 'isConnectAccountConnected'],
            }
        ],
    });

    // Sync Stripe Connect account status if not yet marked as connected
    let isConnectAccountConnected = userData?.agentInfo?.[0]?.isConnectAccountConnected || false;
    const connectAccountId = userData?.agentInfo?.[0]?.connectAccountId || null;

    if (!isConnectAccountConnected && connectAccountId) {
        try {
            const accountStatus = await stripe.checkConnectAccountStatus(connectAccountId);
            if (accountStatus.chargesEnabled && accountStatus.payoutsEnabled && accountStatus.detailsSubmitted) {
                await bussinessInformation.update(
                    { isConnectAccountConnected: true },
                    { where: { id: userData.agentInfo[0].id } }
                );
                isConnectAccountConnected = true;
                console.log('✅ [getBookingHome] Connect account status synced: isConnectAccountConnected = true');
            }
        } catch (stripeErr) {
            console.error('⚠️ [getBookingHome] Failed to sync Connect account status:', stripeErr.message);
        }
    }

    if (!userData?.addressDb?.zoneId) {
        throw new NotFoundError("Agent shop address or zone not found");
    }

    let agentZone = userData.addressDb.zoneId;
    const queryTimeZone =
        req.query?.timeZone ||
        req.body?.timeZone ||
        userData?.ianaTimeZone;
    const queryClientTimeZone = req.query?.clientTimeZone || req.body?.clientTimeZone;
    const resolvedExpireTz = resolveBookingTimeZone(queryTimeZone, queryClientTimeZone);
    const { timeHHmm: currentTimeString } = wallClockNow(queryTimeZone, queryClientTimeZone);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    await markAgentOnline(agentId, agentZone);

    const { getCountryContextFromShopUserId } = require("../../utils/countryTimeZone");
    const agentCountryCtx = await getCountryContextFromShopUserId(agentId);
    const platformOpenNow = await isPlatformOpenNow(
        agentCountryCtx.countryId,
        queryTimeZone || agentCountryCtx.ianaTimeZone,
        queryClientTimeZone
    );
    const { dayOfWeek } = getWallClockContext(queryTimeZone, queryClientTimeZone);
    const todayHours = await findTodayWorkingHoursRow(agentId, dayOfWeek);
    const resolvedAgentTz =
        queryTimeZone || agentCountryCtx.ianaTimeZone;
    const scheduleShopOpen = platformOpenNow
        ? await isShopOpenNow(
            agentId,
            agentCountryCtx.countryId,
            resolvedAgentTz,
            queryClientTimeZone
        )
        : false;
    const agentOnlineNow = await isAgentOnline(agentId);
    const agentShopOpen =
        agentOnlineNow || scheduleShopOpen || !platformOpenNow;
    const zoneShopsOpen = await isAnyShopOpenInZone(
        agentZone,
        resolvedAgentTz,
        queryClientTimeZone
    );

    console.log(
        "[getBookingHome] agent:",
        agentId,
        "zone:",
        agentZone,
        "tz:",
        resolvedExpireTz,
        "day:",
        dayOfWeek,
        "hoursStatus:",
        todayHours?.status,
        "open:",
        todayHours?.openTime,
        "close:",
        todayHours?.closeTime,
        "now:",
        currentTimeString,
        "platformOpenNow:",
        platformOpenNow,
        "scheduleShopOpen:",
        scheduleShopOpen,
        "agentOnlineNow:",
        agentOnlineNow,
        "agentShopOpen:",
        agentShopOpen,
        "zoneShopsOpen:",
        zoneShopsOpen,
        "createdAt >=",
        twentyFourHoursAgo.toISOString()
    );

    if (!agentShopOpen) {
        return ResponseHelper.success(res, "Agent Orders fetched", {
            bookingData: [],
            isConnectAccountConnected,
            connectAccountId,
            agentShopOpen: false,
            zoneShopsOpen: false,
            platformOpenNow,
            afterHoursMode: !platformOpenNow,
        });
    }

    // Shop just opened — release any held bookings for this zone and notify agents immediately.
    const { releaseHeldBookingsForZone } = require("../../services/bookingHeldReleaseService");
    await releaseHeldBookingsForZone(agentZone);

    const declinedBookingIds =
        await agentBookingDeclineService.getDeclinedBookingIdsForAgent(agentId);

    const agentShopId = userData.addressDb.id;

    const bookingWhere = {
        bookingStatusId: 1,
        zoneId: agentZone,
        laundryShopId: null,
        agentBroadcastHeld: { [Op.not]: true },
        createdAt: { [Op.gte]: twentyFourHoursAgo },
        [Op.or]: [
            { adminAssignedShopId: null },
            { adminAssignedShopId: agentShopId },
        ],
    };

    if (declinedBookingIds.length > 0) {
        bookingWhere.id = { [Op.notIn]: declinedBookingIds };
    }

    const bookingData = await booking.findAll({
        where: bookingWhere,
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
            "totalBags",
            "sameBagForAllServices",
            "orderAmount",
            "frequency",
            "deliveryDate",
            "deliveryTimeFrom",
            "deliveryTimeTo",
            "pickupAddresId",
            "dropOffAddressId",
            "laundryShopId",
            "customerId",
            "createdAt",
            "orderExpireTime",
            "adminAssignedShopId",
            "agentVisibleAt",
            "placedOutsidePlatformHours",
        ],
    });

    // Agent's actively-offered service IDs. A broadcast booking is only shown if
    // the agent offers EVERY service the customer selected on that booking.
    const agentServiceRows = await agentSelectServices.findAll({
        where: { agentServiceId: agentId, status: true },
        attributes: ["serviceId"],
    });
    const agentServiceIdSet = new Set(
        agentServiceRows.map((r) => Number(r.serviceId))
    );

    // Map each booking → the distinct service IDs the customer selected on it.
    const bookingIds = bookingData.map((b) => b.id);
    const bookingServiceIds = new Map();
    if (bookingIds.length > 0) {
        const selectedServiceRows = await customerSelectedService.findAll({
            where: { bookingId: { [Op.in]: bookingIds } },
            attributes: ["bookingId", "serviceId"],
        });
        for (const row of selectedServiceRows) {
            const bId = Number(row.bookingId);
            const sId = Number(row.serviceId);
            if (!Number.isFinite(sId) || sId <= 0) continue;
            if (!bookingServiceIds.has(bId)) bookingServiceIds.set(bId, new Set());
            bookingServiceIds.get(bId).add(sId);
        }
    }

    const bookingDataForResponse = [];

    for (const row of bookingData) {
        const plain = row.get({ plain: true });
        if (!plain.orderExpireTime) continue;

        // Skip bookings whose selected services this agent does not fully offer.
        const requiredServiceIds = bookingServiceIds.get(Number(plain.id));
        if (
            !requiredServiceIds ||
            requiredServiceIds.size === 0 ||
            ![...requiredServiceIds].every((id) => agentServiceIdSet.has(id))
        ) {
            continue;
        }

        if (
            !isBookingAcceptWindowOpen(
                getAcceptWindowAnchor(plain),
                plain.orderExpireTime,
                queryTimeZone,
                queryClientTimeZone
            )
        ) {
            continue;
        }

        const pickupOk = await isPickupWithinShopWorkingHours(
            agentId,
            plain.collectionDate,
            plain.collectionTimeFrom,
            plain.collectionTimeTo,
            resolvedAgentTz,
            queryClientTimeZone,
            agentCountryCtx.countryId
        );
        if (!pickupOk) continue;

        const minutesLeft = getAcceptWindowMinutesRemaining(
            getAcceptWindowAnchor(plain),
            plain.orderExpireTime,
            queryTimeZone,
            queryClientTimeZone
        );

        bookingDataForResponse.push({
            ...plain,
            createdAt: plain.createdAt,
            orderExpireTime: formatOrderExpireTimeForApi(plain.orderExpireTime),
            acceptWindowMinutes: minutesLeft,
        });
    }

    return ResponseHelper.success(res, "Agent Orders fetched", {
        bookingData: bookingDataForResponse,
        isConnectAccountConnected,
        connectAccountId,
        agentShopOpen: true,
        zoneShopsOpen,
        platformOpenNow,
        afterHoursMode: !platformOpenNow,
    });
}

exports.agentRejectOrder = async (req, res) => {
    const agentId = req.user.id;
    const { bookingId } = req.body;

    if (!bookingId) {
        throw new ValidationError('bookingId is required');
    }

    const result = await agentBookingDeclineService.rejectBooking(agentId, bookingId);

    const message = result.alreadyDeclined
        ? 'Booking already declined'
        : 'Booking declined successfully';

    return ResponseHelper.success(res, message, result);
};

exports.agentAcceptOrder = async (req, res) => {
    const agentId = req.user.id;
    const { bookingId } = req.body;

    if (!bookingId) {
        throw new ValidationError("bookingId is required");
    }

    const { acceptOrderForAgent } = require("../../services/Agent/agentAcceptOrderService");
    const result = await acceptOrderForAgent(agentId, bookingId, {
        timeZone: req.body?.timeZone,
        clientTimeZone: req.body?.clientTimeZone,
    });

    return ResponseHelper.success(res, "Order accepted successfully", result);
};

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
                image: b.customer?.image,
                ...(() => {
                    const redacted = redactCustomerPhone({
                        phoneNum: b.customer?.phoneNum,
                    });
                    return {
                        phoneNum: redacted.phoneNum,
                        phoneMasked: redacted.phoneMasked,
                        hasPhone: redacted.hasPhone,
                    };
                })(),
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
        const paymentType = normalizePaymentType(bookingfind.paymentType);
        const payload = { bookingfind };
        if (paymentType === "card") {
            payload.oneHourLater = moment().add(1, "hours").format("HH:mm A");
            payload.invoicePaymentWindowApplies = true;
        } else {
            payload.invoicePaymentWindowApplies = false;
        }
        return ResponseHelper.success(
            res,
            `Order Details for ${Object.keys(whereCondition)[0]}: ${Object.values(whereCondition)[0]}`,
            payload
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
    const { filterType } = req.query;

    // ── Shop address ────────────────────────────────────────────────────────
    const addressFound = await addressDb.findOne({
        where: { userId: agentId },
        attributes: ["id", "zoneId"],
    });

    if (!addressFound) {
        throw new NotFoundError("Address not found for agent");
    }

    const shopId  = addressFound.id;
    const zoneId  = addressFound.zoneId;

    // ── Slots shortcut ───────────────────────────────────────────────────────
    if (filterType === "slots") {
        const results = { slots: await getSlotBookings(shopId) };
        return ResponseHelper.success(res, "Booking Details Fetched for all filters", results);
    }

    // ── Shared booking attributes ────────────────────────────────────────────
    const BOOKING_ATTRS = [
        "id", "orderTrackId",
        "collectionTimeFrom", "collectionTimeTo", "collectionDate",
        "deliveryTimeFrom",   "deliveryTimeTo",   "deliveryDate",
        "driverInstructionOptions", "driverInstructionOptions1", "driverInstruction",
        "bookingStatusId", "totalItems", "totalBags",
        "sameBagForAllServices", "noOfBags",
        "pickupAttemptCount", "pickupRescheduleRequired", "deliveryAttemptCount",
    ];

    // ── Fresh includes factory — returns NEW objects every call ─────────────
    //    Sequelize mutates include objects internally; reusing the same array
    //    reference across multiple findAll calls corrupts the 2nd+ queries.
    const makeIncludes = () => [
        { model: bookingStatus, attributes: ["id", "title", "description"] },
        {
            model: addressDb, as: "laundryShop", required: false,
            attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", "postalcode"],
            include: [
                { model: countries, attributes: ["id", "name", "shortName"] },
                { model: cities,    attributes: ["id", "name"] },
            ],
        },
        {
            model: addressDb, as: "pickupAddress", required: false,
            attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", "postalcode"],
            include: [
                { model: countries, attributes: ["id", "name", "shortName"] },
                { model: cities,    attributes: ["id", "name"] },
            ],
        },
        {
            model: addressDb, as: "dropOffAddress", required: false,
            attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", "postalcode"],
            include: [
                { model: countries, attributes: ["id", "name", "shortName"] },
                { model: cities,    attributes: ["id", "name"] },
            ],
        },
        {
            model: users, as: "customer",
            attributes: ["id", "firstName", "lastName", "email", "phoneNum"],
        },
        {
            model: customerSelectedService,
            required: false,
            where: { status: true },
            attributes: ["id", "date", "time", "servicePrice", "categoryPrice", "bookingId", "serviceId", "categoryId", "subCategoryId", "items", "bags", "serviceInstruction", "status"],
            include: [
                { model: service,       required: false, attributes: ["id", "name", "status", "image", "description", "pricingBasis", "numberOfBags", "numberOfItems"] },
                { model: categories,    required: false, attributes: ["id", "name", "status", "image", "description"] },
                { model: subCategories, required: false, attributes: ["id", "name", "price", "status", "description", "barCode", "weightKg", "unitCount"] },
                {
                    model: customerSelectedServiceAddOn, as: "addOns", required: false,
                    attributes: ["id", "customerSelectedServiceId", "addOnServiceId", "price", "items"],
                    include: [{ model: addOnServices, as: "addOnService", required: false, attributes: ["id", "name", "price"] }],
                },
                {
                    model: bookingPreference, as: "selectedServicePreferences", required: false,
                    attributes: ["id", "bookingId", "customerSelectedServiceId", "preferenceTypeId", "preferenceValueId", "parentPreferenceValueId", "preferenceInstruction"],
                    include: [
                        { model: preferenceTypes,  required: false, attributes: ["id", "name"] },
                        { model: preferenceValues, required: false, attributes: ["id", "value"] },
                    ],
                },
            ],
        },
    ];  // <-- end makeIncludes

    // ── displayStatus + attemptFlags helper ──────────────────────────────────
    const addDisplayStatus = (rows) =>
        rows.map((b) => {
            const plain = b.toJSON ? b.toJSON() : b;
            const isPickupFailed   = plain.bookingStatusId === 3 && Boolean(plain.pickupRescheduleRequired);
            const isDeliveryFailed = plain.bookingStatusId === 15;
            const failedAttemptType = isDeliveryFailed ? "delivery" : isPickupFailed ? "pickup" : null;
            plain.displayStatus = isPickupFailed
                ? { id: 3, title: "Pickup Failed", description: "A pickup attempt was unsuccessful" }
                : plain.bookingStatus || null;
            plain.attemptFlags = {
                hasFailedAttempt: Boolean(failedAttemptType),
                failedAttemptType,
                pickupAttemptCount:        Number(plain.pickupAttemptCount) || 0,
                pickupRescheduleRequired:  Boolean(plain.pickupRescheduleRequired),
                deliveryAttemptCount:      Number(plain.deliveryAttemptCount) || 0,
            };
            return plain;
        });

    // ── Date helpers ─────────────────────────────────────────────────────────
    const todayStr         = moment().format("YYYY-MM-DD");
    const tomorrowStr      = moment().add(1, "day").format("YYYY-MM-DD");
    const dayAfterStr      = moment().add(2, "day").format("YYYY-MM-DD");
    const twentyFourHrsAgo = moment().subtract(24, "hours").toDate();

    // Status groups
    const PICKUP_STATUSES    = [3, 4, 5, 6, 7];
    const INVOICE_STATUSES   = [8, 9, 10];
    const PROCESSING_STATUSES = [11, 12, 13, 14, 15, 16];
    const ALL_ACTIVE_STATUSES = [...PICKUP_STATUSES, ...INVOICE_STATUSES, ...PROCESSING_STATUSES];

    const results = {};

    // ── NEW — unaccepted bookings in agent's zone ────────────────────────────
    if (!filterType || filterType === "new") {
        const rows = await booking.findAll({
            where: {
                bookingStatusId: 1,
                laundryShopId: null,
                zoneId,
                agentBroadcastHeld: { [Op.not]: true },
                createdAt: { [Op.gte]: twentyFourHrsAgo },
                [Op.or]: [
                    { adminAssignedShopId: null },
                    { adminAssignedShopId: shopId },
                ],
                [Op.and]: [
                    {
                        [Op.or]: [
                            { orderExpireTime: null },
                            { orderExpireTime: { [Op.gt]: new Date() } },
                        ],
                    },
                ],
            },
            order: [["id", "DESC"]],
            attributes: BOOKING_ATTRS,
            include: makeIncludes(),
        });
        results.New = addDisplayStatus(rows);
        if (filterType === "new") {
            const [countNew, countToday, countTomorrow, countOrders, countInvoice, countProcessing] = await Promise.all([
                booking.count({ where: { bookingStatusId: 1, laundryShopId: null, zoneId, agentBroadcastHeld: { [Op.not]: true }, createdAt: { [Op.gte]: twentyFourHrsAgo }, [Op.or]: [{ adminAssignedShopId: null }, { adminAssignedShopId: shopId }], [Op.and]: [{ [Op.or]: [{ orderExpireTime: null }, { orderExpireTime: { [Op.gt]: new Date() } }] }] } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: todayStr, [Op.lt]: tomorrowStr } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: tomorrowStr, [Op.lt]: dayAfterStr } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: INVOICE_STATUSES } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PROCESSING_STATUSES } } }),
            ]);
            results.counts = { new: countNew, today: countToday, tomorrow: countTomorrow, orders: countOrders, invoice: countInvoice, processing: countProcessing };
            return ResponseHelper.success(res, "New bookings fetched", results);
        }
    }

    // ── TODAY — agent's accepted pickups for today ───────────────────────────
    if (!filterType || filterType === "today") {
        const rows = await booking.findAll({
            where: {
                laundryShopId: shopId,
                bookingStatusId: { [Op.in]: PICKUP_STATUSES },
                collectionDate: { [Op.gte]: todayStr, [Op.lt]: tomorrowStr },
            },
            order: [["collectionDate", "ASC"], ["collectionTimeFrom", "ASC"]],
            attributes: BOOKING_ATTRS,
            include: makeIncludes(),
        });
        results.Today = addDisplayStatus(rows);
        if (filterType === "today") {
            const [countNew, countToday, countTomorrow, countOrders, countInvoice, countProcessing] = await Promise.all([
                booking.count({ where: { bookingStatusId: 1, laundryShopId: null, zoneId, agentBroadcastHeld: { [Op.not]: true }, createdAt: { [Op.gte]: twentyFourHrsAgo }, [Op.or]: [{ adminAssignedShopId: null }, { adminAssignedShopId: shopId }], [Op.and]: [{ [Op.or]: [{ orderExpireTime: null }, { orderExpireTime: { [Op.gt]: new Date() } }] }] } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: todayStr, [Op.lt]: tomorrowStr } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: tomorrowStr, [Op.lt]: dayAfterStr } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: INVOICE_STATUSES } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PROCESSING_STATUSES } } }),
            ]);
            results.counts = { new: countNew, today: countToday, tomorrow: countTomorrow, orders: countOrders, invoice: countInvoice, processing: countProcessing };
            return ResponseHelper.success(res, "Today's bookings fetched", results);
        }
    }

    // ── TOMORROW — agent's accepted pickups for tomorrow ─────────────────────
    if (!filterType || filterType === "tomorrow") {
        const rows = await booking.findAll({
            where: {
                laundryShopId: shopId,
                bookingStatusId: { [Op.in]: PICKUP_STATUSES },
                collectionDate: { [Op.gte]: tomorrowStr, [Op.lt]: dayAfterStr },
            },
            order: [["collectionDate", "ASC"], ["collectionTimeFrom", "ASC"]],
            attributes: BOOKING_ATTRS,
            include: makeIncludes(),
        });
        results.Tomorrow = addDisplayStatus(rows);
        if (filterType === "tomorrow") {
            const [countNew, countToday, countTomorrow, countOrders, countInvoice, countProcessing] = await Promise.all([
                booking.count({ where: { bookingStatusId: 1, laundryShopId: null, zoneId, agentBroadcastHeld: { [Op.not]: true }, createdAt: { [Op.gte]: twentyFourHrsAgo }, [Op.or]: [{ adminAssignedShopId: null }, { adminAssignedShopId: shopId }], [Op.and]: [{ [Op.or]: [{ orderExpireTime: null }, { orderExpireTime: { [Op.gt]: new Date() } }] }] } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: todayStr, [Op.lt]: tomorrowStr } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: tomorrowStr, [Op.lt]: dayAfterStr } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: INVOICE_STATUSES } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PROCESSING_STATUSES } } }),
            ]);
            results.counts = { new: countNew, today: countToday, tomorrow: countTomorrow, orders: countOrders, invoice: countInvoice, processing: countProcessing };
            return ResponseHelper.success(res, "Tomorrow's bookings fetched", results);
        }
    }

    // ── ORDERS — all active bookings (master list) ───────────────────────────
    if (!filterType || filterType === "orders") {
        const rows = await booking.findAll({
            where: {
                laundryShopId: shopId,
                bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES },
            },
            order: [
                [literal(`CASE WHEN bookingStatusId IN (3,4,5,6,7) THEN collectionDate ELSE deliveryDate END IS NULL`), "ASC"],
                [literal(`CASE WHEN bookingStatusId IN (3,4,5,6,7) THEN collectionDate ELSE deliveryDate END`), "ASC"],
                [literal(`CASE WHEN bookingStatusId IN (3,4,5,6,7) THEN collectionTimeFrom ELSE deliveryTimeFrom END IS NULL`), "ASC"],
                [literal(`CASE WHEN bookingStatusId IN (3,4,5,6,7) THEN collectionTimeFrom ELSE deliveryTimeFrom END`), "ASC"],
            ],
            attributes: BOOKING_ATTRS,
            include: makeIncludes(),
        });
        results.Orders = addDisplayStatus(rows);
        if (filterType === "orders") {
            const [countNew, countToday, countTomorrow, countOrders, countInvoice, countProcessing] = await Promise.all([
                booking.count({ where: { bookingStatusId: 1, laundryShopId: null, zoneId, agentBroadcastHeld: { [Op.not]: true }, createdAt: { [Op.gte]: twentyFourHrsAgo }, [Op.or]: [{ adminAssignedShopId: null }, { adminAssignedShopId: shopId }], [Op.and]: [{ [Op.or]: [{ orderExpireTime: null }, { orderExpireTime: { [Op.gt]: new Date() } }] }] } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: todayStr, [Op.lt]: tomorrowStr } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: tomorrowStr, [Op.lt]: dayAfterStr } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: INVOICE_STATUSES } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PROCESSING_STATUSES } } }),
            ]);
            results.counts = { new: countNew, today: countToday, tomorrow: countTomorrow, orders: countOrders, invoice: countInvoice, processing: countProcessing };
            return ResponseHelper.success(res, "Orders fetched", results);
        }
    }

    // ── INVOICE — delivered to shop → services added → invoice generated ─────
    if (!filterType || filterType === "invoice") {
        const rows = await booking.findAll({
            where: {
                laundryShopId: shopId,
                bookingStatusId: { [Op.in]: INVOICE_STATUSES },
            },
            order: [
                [literal("deliveryDate IS NULL"), "ASC"],
                ["deliveryDate", "ASC"],
                [literal("deliveryTimeFrom IS NULL"), "ASC"],
                ["deliveryTimeFrom", "ASC"],
            ],
            attributes: BOOKING_ATTRS,
            include: makeIncludes(),
        });
        results.Invoice = addDisplayStatus(rows);
        if (filterType === "invoice") {
            const [countNew, countToday, countTomorrow, countOrders, countInvoice, countProcessing] = await Promise.all([
                booking.count({ where: { bookingStatusId: 1, laundryShopId: null, zoneId, agentBroadcastHeld: { [Op.not]: true }, createdAt: { [Op.gte]: twentyFourHrsAgo }, [Op.or]: [{ adminAssignedShopId: null }, { adminAssignedShopId: shopId }], [Op.and]: [{ [Op.or]: [{ orderExpireTime: null }, { orderExpireTime: { [Op.gt]: new Date() } }] }] } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: todayStr, [Op.lt]: tomorrowStr } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: tomorrowStr, [Op.lt]: dayAfterStr } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: INVOICE_STATUSES } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PROCESSING_STATUSES } } }),
            ]);
            results.counts = { new: countNew, today: countToday, tomorrow: countTomorrow, orders: countOrders, invoice: countInvoice, processing: countProcessing };
            return ResponseHelper.success(res, "Invoice bookings fetched", results);
        }
    }

    // ── PROCESSING — processing → delivery → delivered ───────────────────────
    if (!filterType || filterType === "processing") {
        const rows = await booking.findAll({
            where: {
                laundryShopId: shopId,
                bookingStatusId: { [Op.in]: PROCESSING_STATUSES },
            },
            order: [
                [literal("deliveryDate IS NULL"), "ASC"],
                ["deliveryDate", "ASC"],
                [literal("deliveryTimeFrom IS NULL"), "ASC"],
                ["deliveryTimeFrom", "ASC"],
            ],
            attributes: BOOKING_ATTRS,
            include: makeIncludes(),
        });
        results.Processing = addDisplayStatus(rows);
        if (filterType === "processing") {
            const [countNew, countToday, countTomorrow, countOrders, countInvoice, countProcessing] = await Promise.all([
                booking.count({ where: { bookingStatusId: 1, laundryShopId: null, zoneId, agentBroadcastHeld: { [Op.not]: true }, createdAt: { [Op.gte]: twentyFourHrsAgo }, [Op.or]: [{ adminAssignedShopId: null }, { adminAssignedShopId: shopId }], [Op.and]: [{ [Op.or]: [{ orderExpireTime: null }, { orderExpireTime: { [Op.gt]: new Date() } }] }] } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: todayStr, [Op.lt]: tomorrowStr } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: tomorrowStr, [Op.lt]: dayAfterStr } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: INVOICE_STATUSES } } }),
                booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PROCESSING_STATUSES } } }),
            ]);
            results.counts = { new: countNew, today: countToday, tomorrow: countTomorrow, orders: countOrders, invoice: countInvoice, processing: countProcessing };
            return ResponseHelper.success(res, "Processing bookings fetched", results);
        }
    }

    // ── Backward compat — no filterType returns everything ───────────────────
    // Keep old "All" key so existing Flutter code doesn't break
    if (!filterType) {
        results.All = [
            ...(results.Today    || []),
            ...(results.Tomorrow || []),
            ...(results.Orders   || []),
        ];
    }

    // ── COUNTS — always returned for tab badge updates ────────────────────────
    const [countNew, countToday, countTomorrow, countOrders, countInvoice, countProcessing] = await Promise.all([
        booking.count({ where: { bookingStatusId: 1, laundryShopId: null, zoneId, agentBroadcastHeld: { [Op.not]: true }, createdAt: { [Op.gte]: twentyFourHrsAgo }, [Op.or]: [{ adminAssignedShopId: null }, { adminAssignedShopId: shopId }], [Op.and]: [{ [Op.or]: [{ orderExpireTime: null }, { orderExpireTime: { [Op.gt]: new Date() } }] }] } }),
        booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: todayStr, [Op.lt]: tomorrowStr } } }),
        booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PICKUP_STATUSES }, collectionDate: { [Op.gte]: tomorrowStr, [Op.lt]: dayAfterStr } } }),
        booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES } } }),
        booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: INVOICE_STATUSES } } }),
        booking.count({ where: { laundryShopId: shopId, bookingStatusId: { [Op.in]: PROCESSING_STATUSES } } }),
    ]);
    results.counts = { new: countNew, today: countToday, tomorrow: countTomorrow, orders: countOrders, invoice: countInvoice, processing: countProcessing };

    return ResponseHelper.success(res, "Booking Details Fetched for all filters", results);
};

exports.getAgentOrderHistory = async (req, res) => {
    const agentId = req.user.id;
    const { status, page, limit } = req.query;

    const result = await agentOrderManagementService.getOrderHistory(agentId, {
        status,
        page,
        limit,
    });

    return ResponseHelper.success(
        res,
        'Agent order history fetched successfully',
        result
    );
};

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
                attributes: ['id', 'firstName', 'lastName', 'email', 'stripeCustomerId'],
            },
            {
                model: billingDetails,
                as: 'billingDetail',
                required: false,
                attributes: ['upfrontAmount', 'serviceCharge', 'total', 'paymentStatus'],
            },
            {
                model: tip,
                as: 'tips',
                attributes: ['id', 'amount'],
                required: false,
            },
        ],
    });

    if (!bookingfind) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingfind);

    if (bookingfind.bookingStatusId !== 3) {
        throw new NotFoundError("No driver is assigned to this booking yet");
    }

    const paymentType = bookingfind.paymentType || "card";

    if (paymentType === "cash") {
        if (bookingfind.bookingStatusId !== 4) {
            await booking.update(
                { bookingStatusId: 4 },
                { where: { id: bookingId } }
            );

            await bookingHistory.create({
                bookingId,
                date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
                time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
                bookingStatusId: 4,
            });
        }

        const customerId = bookingfind.customerId;
        sendNotification(
            customerId,
            "Driver On The Way",
            "Your driver is on the way to the pickup location",
            { bookingId, driverId: bookingfind.driverId }
        );

        return ResponseHelper.success(res, "Booking status updated (cash — no pickup charge)", {
            bookingId,
            paymentType: "cash",
            paymentStatus: "cash_pending",
            amountCharged: 0,
        });
    }

    // Validate required payment data (card bookings)
    if (!bookingfind.customer.stripeCustomerId) {
        throw new ValidationError("Stripe customer ID not found for this booking");
    }

    if (!bookingfind.paymentMethodId) {
        throw new ValidationError("Payment method not found. Setup Intent was not completed properly.");
    }

    const upfrontAmount = parseFloat(bookingfind.billingDetail?.upfrontAmount || 0) || 0;
    const serviceCharge = parseFloat(bookingfind.billingDetail?.serviceCharge || 0) || 0;
    const driverTip =
        bookingfind.tips && bookingfind.tips.length > 0
            ? bookingfind.tips.reduce(
                  (sum, t) => sum + (parseFloat(t.amount) || 0),
                  0
              )
            : 0;
    const basePickupCharge = getPickupChargeAmount(upfrontAmount, serviceCharge, 0);
    const initialChargeAmount = getPickupChargeAmount(
        upfrontAmount,
        serviceCharge,
        driverTip
    );

    if (!basePickupCharge || basePickupCharge <= 0) {
        throw new ValidationError("Upfront amount not set for this booking");
    }

    // IDEMPOTENCY CHECK: If payment already confirmed, skip charging and just update status if needed
    if (bookingfind.paymentConfirmed) {
        console.log("⚠️ Payment already confirmed for this booking - skipping charge");
        console.log(`📋 Existing Payment Intent ID: ${bookingfind.paymentIntentId}`);

        // Still update status to "On The Way" if needed
        if (bookingfind.bookingStatusId !== 4) {
            await booking.update(
                { bookingStatusId: 4 },
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
                date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
                time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
                bookingStatusId: 4,
            });
        }

        return res.status(200).json({
            status: "1",
            message: "Booking status updated to On The Way (Payment already confirmed)",
            data: {
                bookingId: bookingId,
                status: "On The Way",
                paymentStatus: "Already Confirmed",
                paymentIntentId: bookingfind.paymentIntentId
            }
        });
    }

    console.log("💳 Capturing / charging prepaid for booking:", bookingId);
    console.log("💰 Upfront Amount:", upfrontAmount);
    console.log("💰 Service Charge:", serviceCharge);
    console.log("💰 Driver Tip:", driverTip);
    console.log("💰 Initial Charge (upfront + service + tip):", initialChargeAmount);
    console.log("👤 Customer:", bookingfind.customer.stripeCustomerId);
    console.log("💳 Payment Method:", bookingfind.paymentMethodId);
    console.log("🔑 Existing Payment Intent:", bookingfind.paymentIntentId);

    const orderLabel = bookingfind.orderTrackId || String(bookingId);

    const agentUser = await users.findByPk(req.user.id, {
        attributes: ["id", "firstName", "lastName", "email"],
    });

    const stripePresentation = buildStripeChargePresentation({
        chargeType: "pickup",
        bookingId,
        orderTrackId: bookingfind.orderTrackId,
        amount: initialChargeAmount,
        currency: "GBP",
        paymentType,
        customer: bookingfind.customer || { id: bookingfind.customerId },
        agent: agentUser || { id: req.user?.id },
        billing: {
            upfrontAmount,
            serviceFee: serviceCharge,
            driverTip,
        },
        zoneId: bookingfind.zoneId,
        laundryShopId: bookingfind.laundryShopId,
    });

    let paymentIntent = null;
    let captureMode = "new_charge";

    // Prefer capturing the authorization hold created at booking
    if (bookingfind.paymentIntentId) {
        try {
            const existingIntent = await getIntent(bookingfind.paymentIntentId);
            if (existingIntent?.status === "requires_capture") {
                captureMode = "auth_hold_capture";
                paymentIntent = await capturePaymentIntent(
                    bookingfind.paymentIntentId,
                    {
                        idempotencyKey: `booking_${bookingId}_capture_hold`,
                        stripeOptions: stripePresentation,
                    }
                );
                console.log(
                    `✅ Auth hold captured: ${paymentIntent.id}, status=${paymentIntent.status}`
                );
            } else if (existingIntent?.status === "succeeded") {
                captureMode = "already_succeeded";
                paymentIntent = existingIntent;
                console.log(
                    `⚠️ PaymentIntent ${existingIntent.id} already succeeded — marking confirmed`
                );
            } else {
                console.warn(
                    `⚠️ Existing PI ${bookingfind.paymentIntentId} status=${existingIntent?.status}; falling back to off-session charge`
                );
            }
        } catch (holdErr) {
            console.error(
                `⚠️ Failed to capture auth hold for booking ${bookingId}:`,
                holdErr.message
            );
        }
    }

    // Legacy bookings (no hold) or hold unusable — charge off-session as before
    if (!paymentIntent) {
        const idempotencyKey = `booking_${bookingId}_ontheway_${Date.now()}`;
        console.log(`🔒 Fallback charge idempotency key: ${idempotencyKey}`);
        paymentIntent = await chargeOffSession(
            initialChargeAmount,
            bookingfind.customer.stripeCustomerId,
            bookingfind.paymentMethodId,
            idempotencyKey,
            stripePresentation
        );
        captureMode = "new_charge";
        console.log(
            "✅ Payment charged successfully:",
            paymentIntent.id,
            "Status:",
            paymentIntent.status
        );
    }

    if (paymentIntent.status !== "succeeded" && !paymentIntent.alreadyCaptured) {
        throw new ValidationError(`Payment failed. Status: ${paymentIntent.status}`);
    }

    await booking.update(
        {
            bookingStatusId: 4,
            paymentIntentId: paymentIntent.id,
            paymentConfirmed: true,
        },
        { where: { id: bookingId } }
    );

    await bookingHistory.create({
        bookingId,
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
        bookingStatusId: 4,
    });

    const customerId = bookingfind.customerId;
    sendNotification(
        customerId,
        "Driver On The Way",
        "Your driver is on the way to the pickup location",
        {
            bookingId: bookingId,
            driverId: bookingfind.driverId,
        }
    );

    return ResponseHelper.success(res, "Booking status updated and payment captured", {
        paymentIntentId: paymentIntent.id,
        paymentStatus: "succeeded",
        amountCharged: initialChargeAmount,
        upfrontAmount,
        serviceCharge,
        driverTip,
        captureMode,
        orderLabel,
    });
}

/*
 *   Agent Booking status Arrived
 */
exports.driverStatusArrived = async (req, res) => {
    const { bookingId } = req.params;
    const { driverLat, driverLng, geofenceBypassToken } = req.body;

    const { assertDriverWithinCustomerRadius } = require("../../utils/driverGeofence");
    await assertDriverWithinCustomerRadius({
        bookingId,
        leg: "pickup",
        driverLat,
        driverLng,
        geofenceBypassToken,
    });

    const bookingfind = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (!bookingfind) {
        throw new NotFoundError(`Booking with this id: ${bookingId} not exists`);
    }

    assertBookingNotCancelledForAgent(bookingfind);

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
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
        bookingStatusId: 5,
        bookingId: bookingId,
    });

    const noShowEnforcementService = require("../../services/Agent/noShowEnforcementService");
    await noShowEnforcementService.openAttempt({
        bookingId,
        attemptType: "pickup",
        driverId: bookingfind.driverId,
    });

    const customerId = bookingfind.customerId;
    let title = "Driver Arrived";
    let body = "Your driver has arrived at the pickup location";
    let data = {
        bookingId: bookingId,
        driverId: bookingfind.driverId,
    }
    sendNotification(customerId, title, body, data);

    // Send driver arrived email (non-blocking)
    try {
        const driverArrivedMail = require('../../helper/driverArrivedMail');
        const customerData = await users.findOne({
            where: { id: customerId },
            attributes: ['firstName', 'email']
        });
        if (customerData?.email) {
            await driverArrivedMail({
                email: customerData.email,
                userName: customerData.firstName || 'Customer'
            });
            console.log('✅ Driver arrived email sent to:', customerData.email);
        }
    } catch (emailError) {
        console.error('⚠️ Failed to send driver arrived email (non-blocking):', emailError.message);
    }

    return ResponseHelper.success(res, "Booking Status Updated to Driver Arrived", {});
}

/*
 *   Driver/Agent Add pictures of pickup and delivery
 */
exports.AddPickupDeliveryProof = async (req, res) => {
    const { noOfItems, note, bookingId, deliveryType, noOfBags } = req.body;
    const userId = req.user.id;

    if (!bookingId) {
        throw new ValidationError("bookingId is required");
    }

    const normalizedDeliveryType = normalizeProofDeliveryType(deliveryType);
    if (!normalizedDeliveryType) {
        throw new ValidationError("deliveryType is required (pickUp or dropOff)");
    }

    if (!req.files?.length) {
        throw new ValidationError("Proof Images are not uploaded. Please Upload the Images");
    }

    const parsedItems = parseOptionalProofCount(noOfItems, "noOfItems");
    const parsedBags = parseOptionalProofCount(noOfBags, "noOfBags");

    const bookingFind = await booking.findOne({ where: { id: bookingId } });
    if (!bookingFind) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingFind);

    const trimmedNote =
        note != null && String(note).trim() !== "" ? String(note).trim() : null;

    const imgArr = req.files.map((ele) => {
        const imagePath = ele.path.replace(/\\/g, "/");
        const row = {
            imgUpload: imagePath,
            userId,
            bookingId,
            note: trimmedNote,
            deliveryType: normalizedDeliveryType,
        };
        if (parsedItems !== undefined) {
            row.noOfItems = parsedItems;
        }
        if (parsedBags !== undefined) {
            row.noOfBags = parsedBags;
        }
        return row;
    });

    await proofOfDeliveries.bulkCreate(imgArr);

    const bookingUpdates = {};
    if (parsedItems !== undefined) {
        bookingUpdates.totalItems = parsedItems;
    }
    if (parsedBags !== undefined) {
        bookingUpdates.noOfBags = parsedBags;
        bookingUpdates.totalBags = parsedBags;
    }

    if (Object.keys(bookingUpdates).length > 0) {
        await booking.update(bookingUpdates, { where: { id: bookingId } });
    }

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

    if (!bookingFind) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingFind);

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
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
        bookingId: bookingId,
        bookingStatusId: statusId
    }))
    await bookingHistory.bulkCreate(bookinghistories);

    const noShowEnforcementService = require("../../services/Agent/noShowEnforcementService");
    await noShowEnforcementService.completeOpenAttempt(bookingId, "pickup");

    const customerId = bookingFind.customerId;
    let title = "Driver Picked Up";
    let body = "Your driver has picked up your laundry";
    let data = {
        bookingId: bookingId,
        driverId: bookingFind.driverId,
    }
    sendNotification(customerId, title, body, data);

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

    if (!bookingCheck) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingCheck);

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
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
        bookingId: bookingId,
        bookingStatusId: 8,
    });

    const customerId = bookingCheck.customerId;
    let title = "Driver Reached At Laundry Shop";
    let body = "Your driver has reached at the laundry shop";
    let data = {
        bookingId: bookingId,
        driverId: bookingCheck.driverId,
    }
    sendNotification(customerId, title, body, data);

    return ResponseHelper.success(res, "Driver Reached At Laundry Shop", {});
}


/*
 *  Create balance payment intent — amount is always server-calculated (amountDueNow).
 */
exports.createIntentUsingStripeForAgent = async (req, res) => {
    const { bookingId, customerId, savedPaymentMethodId, amount: clientAmount } =
        req.body;

    if (!bookingId) {
        throw new ValidationError("bookingId is required");
    }

    const bookingRow = await booking.findOne({
        where: { id: bookingId },
        include: [
            {
                model: users,
                as: "customer",
                attributes: ["id", "firstName", "lastName", "email", "stripeCustomerId"],
            },
            {
                model: billingDetails,
                as: "billingDetail",
                required: false,
                attributes: ["total", "paymentStatus"],
            },
        ],
    });

    if (!bookingRow) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingRow);

    if ((bookingRow.paymentType || "card") === "cash") {
        throw new ValidationError(
            "This is a cash booking. Use POST /agent/recordCashPayment instead of Stripe."
        );
    }

    const balanceMethod = resolveBalancePaymentMethod(bookingRow);
    if (balanceMethod === "cash") {
        throw new ValidationError(
            "Balance collection is set to cash. Use POST /agent/recordCashPayment instead of Stripe."
        );
    }

    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const chargeAmount = paymentSummary.amountDueNow;

    if (bookingRow.billingDetail?.paymentStatus === "Paid" && chargeAmount <= 0) {
        return ResponseHelper.success(res, "Balance already paid", {
            bookingId,
            paymentSummary,
            chargeAmount: 0,
            alreadyPaid: true,
        });
    }

    if (chargeAmount <= 0) {
        return ResponseHelper.success(res, "No balance due for this booking", {
            bookingId,
            paymentSummary,
            chargeAmount: 0,
        });
    }

    if (clientAmount != null && clientAmount !== "") {
        const parsedClientAmount = parseFloat(clientAmount);
        if (
            Number.isFinite(parsedClientAmount) &&
            Math.abs(parsedClientAmount - chargeAmount) > 0.02
        ) {
            throw new ValidationError(
                `Amount mismatch. Balance due is ${chargeAmount.toFixed(2)}, received ${parsedClientAmount.toFixed(2)}`
            );
        }
    }

    const stripeCustomerId =
        customerId || bookingRow.customer?.stripeCustomerId;
    const paymentMethodId =
        savedPaymentMethodId || bookingRow.paymentMethodId;

    if (!stripeCustomerId) {
        throw new ValidationError("Stripe customer ID not found for this booking");
    }

    if (!paymentMethodId) {
        throw new ValidationError(
            "Payment method not found. Customer must complete card setup first."
        );
    }

    const idempotencyKey = `booking_${bookingId}_balance_${Date.now()}`;
    const agentUser = await users.findByPk(req.user.id, {
        attributes: ["id", "firstName", "lastName", "email"],
    });

    const stripePresentation = buildStripeChargePresentation({
        chargeType: "delivery_balance",
        bookingId,
        orderTrackId: bookingRow.orderTrackId,
        amount: chargeAmount,
        currency: "GBP",
        paymentType: bookingRow.paymentType || "card",
        customer: bookingRow.customer || { id: bookingRow.customerId },
        agent: agentUser || { id: req.user?.id },
        billing: {
            totalOrderAmount: paymentSummary?.orderSummary?.totalOrderAmount,
        },
        zoneId: bookingRow.zoneId,
        laundryShopId: bookingRow.laundryShopId,
    });

    const paymentIntent = await chargeOffSession(
        chargeAmount,
        stripeCustomerId,
        paymentMethodId,
        idempotencyKey,
        stripePresentation
    );

    if (paymentIntent.status !== "succeeded") {
        throw new ValidationError(
            `Payment failed. Status: ${paymentIntent.status}`
        );
    }

    const fullOrderTotal =
        paymentSummary?.orderSummary?.totalOrderAmount ?? chargeAmount;

    await billingDetails.update(
        {
            total: fullOrderTotal,
            paymentStatus: "Paid",
        },
        { where: { bookingId } }
    );

    await booking.update(
        {
            orderAmount: fullOrderTotal,
            paymentIntentId: paymentIntent.id,
            balanceCollectedVia: "card",
        },
        { where: { id: bookingId } }
    );

    await tryCreditAgentWallet(bookingId);

    const updatedPaymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);

    return ResponseHelper.success(res, "Balance payment charged successfully", {
        bookingId,
        paymentIntentId: paymentIntent.id,
        chargeAmount,
        paymentSummary: updatedPaymentSummary,
    });
};

/*
 * Set how the delivery balance will be collected (card or cash).
 */
exports.setBalancePaymentMethod = async (req, res) => {
    const bookingId = req.params.id;
    const { balancePaymentMethod } = req.body;

    if (!bookingId) {
        throw new ValidationError("bookingId is required");
    }

    const normalized = normalizePaymentType(balancePaymentMethod);
    if (!balancePaymentMethod || (normalized !== "card" && normalized !== "cash")) {
        throw new ValidationError("balancePaymentMethod must be 'card' or 'cash'");
    }

    const bookingRow = await booking.findByPk(bookingId, {
        include: [
            {
                model: billingDetails,
                as: "billingDetail",
                required: false,
                attributes: ["paymentStatus"],
            },
        ],
    });

    if (!bookingRow) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingRow);

    if ((bookingRow.paymentType || "card") === "cash" && normalized === "card") {
        throw new ValidationError(
            "Cash bookings must be collected in cash at delivery"
        );
    }

    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);

    if (
        paymentSummary.amountDueNow <= 0 &&
        bookingRow.billingDetail?.paymentStatus === "Paid"
    ) {
        throw new ValidationError(
            "No balance due — payment collection method cannot be changed"
        );
    }

    await bookingRow.update({ balancePaymentMethod: normalized });

    const updatedPaymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);

    return ResponseHelper.success(res, "Balance payment method updated", {
        bookingId: Number(bookingId),
        balancePaymentMethod: normalized,
        paymentSummary: updatedPaymentSummary,
    });
};

/*
 * Record cash collected at delivery (cash bookings or card upfront + cash balance).
 */
exports.recordCashPayment = async (req, res) => {
    const { bookingId, amountCollected } = req.body;

    if (!bookingId) {
        throw new ValidationError("bookingId is required");
    }

    const bookingRow = await booking.findOne({
        where: { id: bookingId },
        include: [
            {
                model: billingDetails,
                as: "billingDetail",
                required: false,
                attributes: ["total", "paymentStatus"],
            },
        ],
    });

    if (!bookingRow) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingRow);

    const balanceMethod = resolveBalancePaymentMethod(bookingRow);
    const isCashBooking = (bookingRow.paymentType || "card") === "cash";

    if (!isCashBooking && balanceMethod !== "cash") {
        throw new ValidationError(
            "Cash recording is only allowed when balance collection is set to cash. " +
                "Use PATCH /agent/booking/:id/balance-payment-method or charge by card."
        );
    }

    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const amountDue = paymentSummary.amountDueNow;

    // Cash COD: only "already paid" after paymentConfirmed (ignore premature billing Paid)
    const alreadySettled = isCashBooking
        ? Boolean(bookingRow.paymentConfirmed) && amountDue <= 0
        : bookingRow.billingDetail?.paymentStatus === "Paid" && amountDue <= 0;

    if (alreadySettled) {
        const paymentFlags = buildCollectPaymentFlags({
            paymentType: bookingRow.paymentType || "cash",
            paymentConfirmed: true,
            amountDueNow: 0,
            balancePaymentMethod: balanceMethod,
            balanceCollectedVia: bookingRow.balanceCollectedVia || "cash",
            billingPaymentStatus: "Paid",
            bookingStatusId: bookingRow.bookingStatusId,
        });
        return ResponseHelper.success(res, "Cash already recorded for this booking", {
            bookingId,
            paymentSummary,
            amountCollected: 0,
            alreadyPaid: true,
            ...paymentFlags,
        });
    }

    if (amountDue <= 0) {
        const fullOrderTotal =
            paymentSummary?.orderSummary?.totalOrderAmount ?? 0;
        if (
            bookingRow.billingDetail?.paymentStatus !== "Paid" &&
            fullOrderTotal > 0
        ) {
            await billingDetails.update(
                {
                    total: fullOrderTotal,
                    paymentStatus: "Paid",
                },
                { where: { bookingId } }
            );
            await booking.update(
                { orderAmount: fullOrderTotal },
                { where: { id: bookingId } }
            );
            await tryCreditAgentWallet(bookingId);
            const updatedPaymentSummary =
                await invoiceManagementService.getPaymentSummaryForBooking(
                    bookingId
                );
            return ResponseHelper.success(
                res,
                "No balance due — order fully covered by upfront payment",
                {
                    bookingId,
                    paymentSummary: updatedPaymentSummary,
                    amountCollected: 0,
                }
            );
        }
        return ResponseHelper.success(res, "No balance due for this booking", {
            bookingId,
            paymentSummary,
            amountCollected: 0,
        });
    }

    if (amountCollected != null && amountCollected !== "") {
        const parsedCollected = parseFloat(amountCollected);
        if (
            Number.isFinite(parsedCollected) &&
            Math.abs(parsedCollected - amountDue) > 0.02
        ) {
            throw new ValidationError(
                `Amount mismatch. Balance due is ${amountDue.toFixed(2)}, received ${parsedCollected.toFixed(2)}`
            );
        }
    }

    const collectedAmount = amountDue;
    const fullOrderTotal =
        paymentSummary?.orderSummary?.totalOrderAmount ?? collectedAmount;

    await billingDetails.update(
        {
            total: fullOrderTotal,
            paymentStatus: "Paid",
        },
        { where: { bookingId } }
    );

    await booking.update(
        {
            orderAmount: fullOrderTotal,
            paymentConfirmed: true,
            balanceCollectedVia: "cash",
        },
        { where: { id: bookingId } }
    );

    await tryCreditAgentWallet(bookingId, { cashCollectedAmount: collectedAmount });

    const updatedPaymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);

    const paymentFlags = buildCollectPaymentFlags({
        paymentType: bookingRow.paymentType || "cash",
        paymentConfirmed: true,
        amountDueNow: 0,
        balancePaymentMethod: balanceMethod,
        billingPaymentStatus: "Paid",
    });

    return ResponseHelper.success(res, "Cash payment recorded successfully", {
        bookingId,
        paymentType: bookingRow.paymentType || "cash",
        balancePaymentMethod: balanceMethod,
        amountCollected: collectedAmount,
        paymentSummary: updatedPaymentSummary,
        ...paymentFlags,
    });
};



/*
 *   Laundry Status Updated Invoice Generated and Status goes to In-Procesing
 *   Cash COD: proceed unpaid (collect after delivery via recordCashPayment).
 *   Card: require full payment first (unless balance method is cash).
 */
exports.bookingInvoiceGeneratedStatusUpdated = async (req, res) => {
    const { bookingId } = req.params;

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
        include: [
            {
                model: billingDetails,
                as: "billingDetail",
                required: false,
                attributes: ["paymentStatus", "total"],
            },
        ],
    });

    if (!bookingCheck) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingCheck);

    if (bookingCheck.bookingStatusId !== 9) {
        throw new ValidationError("Booking is still not In Transit to Facility");
    }

    const paymentType = normalizePaymentType(bookingCheck.paymentType);
    const isCashBooking = paymentType === "cash";
    const balanceMethod = resolveBalancePaymentMethod(bookingCheck);
    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const amountDue = Number(paymentSummary?.amountDueNow ?? 0);
    const billingPaid = bookingCheck.billingDetail?.paymentStatus === "Paid";
    const isFullyPaid = billingPaid || amountDue <= 0.02;

    // Card with card balance: payment must be collected before processing
    if (!isCashBooking && amountDue > 0.02 && balanceMethod !== "cash") {
        throw new ValidationError(
            "Payment required before processing. Collect card payment first, or set balance method to cash for pay-after-delivery."
        );
    }

    if (isFullyPaid) {
        await booking.update(
            {
                bookingStatusId: 11,
                paymentConfirmed: true,
            },
            { where: { id: bookingId } }
        );

        if (!billingPaid) {
            await billingDetails.update(
                { paymentStatus: "Paid" },
                { where: { bookingId } }
            );
        }

        await tryCreditAgentWallet(bookingId);
    } else {
        // Cash COD (or card + cash balance): advance without marking Paid
        await booking.update(
            { bookingStatusId: 11 },
            { where: { id: bookingId } }
        );

        if (!billingPaid) {
            await billingDetails.update(
                { paymentStatus: "Pending" },
                { where: { bookingId } }
            );
        }
    }

    const statusId = [10, 11];
    const bookinghistories = statusId.map(statusId => ({
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
        bookingId: bookingId,
        bookingStatusId: statusId
    }))
    await bookingHistory.bulkCreate(bookinghistories);

    const customerId = bookingCheck.customerId;
    let title = "Laundry Invoice Generated";
    let body = "Your laundry invoice has been generated";
    let data = {
        bookingId: bookingId,
        driverId: bookingCheck.driverId,
    }
    sendNotification(customerId, title, body, data);

    const paymentFlags = buildCollectPaymentFlags({
        paymentType,
        paymentConfirmed: isFullyPaid,
        amountDueNow: isFullyPaid ? 0 : amountDue,
        balancePaymentMethod: balanceMethod,
        balanceCollectedVia: bookingCheck.balanceCollectedVia,
        billingPaymentStatus: isFullyPaid ? "Paid" : "Pending",
        bookingStatusId: 11,
    });

    return ResponseHelper.success(res, "Driver Reached At Laundry Shop", {
        bookingId: Number(bookingId),
        bookingStatusId: 11,
        ...paymentFlags,
        paymentSummary: {
            ...paymentSummary,
            ...paymentFlags,
            paymentType: paymentFlags.paymentType,
        },
    });
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

    if (!bookingCheck) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingCheck);

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
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
        bookingStatusId: 12,
        bookingId: bookingId,
    });
    const customerId = bookingCheck.customerId;
    let title = "Laundry Has Been Washed At Shop";
    let body = "Your laundry has been washed at the shop";
    let data = {
        bookingId: bookingId,
        driverId: bookingCheck.driverId,
    }
    sendNotification(customerId, title, body, data);
    return ResponseHelper.success(res, "Laundry Has Been Washed At Shop", {});
}

/*
 *   Laundry Status Updated That Laundry is Out for Delivery to Customer
 */
exports.laundryDeliverToCustomer = async (req, res) => {
    const { bookingId } = req.params;

    const driverId = req.query.driverId;

    const agentId = req.user.id;

    const bookingCheck = await booking.findOne({ where: { id: bookingId } });
    if (!bookingCheck) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }
    assertBookingNotCancelledForAgent(bookingCheck);

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
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
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
    const { driverLat, driverLng, geofenceBypassToken } = req.body;

    const { assertDriverWithinCustomerRadius } = require("../../utils/driverGeofence");
    await assertDriverWithinCustomerRadius({
        bookingId,
        leg: "delivery",
        driverLat,
        driverLng,
        geofenceBypassToken,
    });

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (!bookingCheck) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingCheck);

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
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
        bookingId: bookingId,
        bookingStatusId: 14,
    });

    const noShowEnforcementService = require("../../services/Agent/noShowEnforcementService");
    await noShowEnforcementService.openAttempt({
        bookingId,
        attemptType: "delivery",
        driverId: bookingCheck.driverId,
    });

    const customerId = bookingCheck.customerId;
    let title = "Driver Reached at Customer Destination";
    let body = "Your driver has reached at the customer destination";
    let data = {
        bookingId: bookingId,
        driverId: bookingCheck.driverId,
    }
    sendNotification(customerId, title, body, data);

    let paymentFlags = {};
    let paymentSummary = null;
    try {
        paymentSummary =
            await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
        paymentFlags = buildCollectPaymentFlags({
            paymentType: bookingCheck.paymentType,
            paymentConfirmed: Boolean(bookingCheck.paymentConfirmed),
            amountDueNow: paymentSummary?.amountDueNow,
            balancePaymentMethod: bookingCheck.balancePaymentMethod,
            balanceCollectedVia: bookingCheck.balanceCollectedVia,
            billingPaymentStatus:
                paymentSummary?.billingPaymentStatus || "Pending",
            bookingStatusId: 14,
        });
    } catch (err) {
        console.error(
            `[driverReachedForDelivery] payment flags failed for ${bookingId}:`,
            err.message
        );
    }

    return ResponseHelper.success(res, "Driver reached for delivery", {
        bookingId: Number(bookingId),
        bookingStatusId: 14,
        amountDueNow: paymentSummary?.amountDueNow ?? paymentFlags.amountDueNow,
        ...paymentFlags,
        paymentSummary: paymentSummary
            ? {
                  ...paymentSummary,
                  ...paymentFlags,
                  paymentType: paymentFlags.paymentType || paymentSummary.paymentType,
              }
            : paymentSummary,
    });
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

    if (!bookingCheck) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingCheck);

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
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
        bookingId: bookingId,
        bookingStatusId: statusId
    }))
    await bookingHistory.bulkCreate(bookinghistories);

    const noShowEnforcementService = require("../../services/Agent/noShowEnforcementService");
    await noShowEnforcementService.completeOpenAttempt(bookingId, "delivery");

    const customerId = bookingCheck.customerId;
    let title = "Laundry Delivered to Customer";
    let body = "Your laundry has been delivered to customer";
    let data = {
        bookingId: bookingId,
        driverId: bookingCheck.driverId,
    }
    sendNotification(customerId, title, body, data);

    let paymentFlags = {};
    let paymentSummary = null;
    try {
        paymentSummary =
            await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
        paymentFlags = buildCollectPaymentFlags({
            paymentType: bookingCheck.paymentType,
            paymentConfirmed: Boolean(bookingCheck.paymentConfirmed),
            amountDueNow: paymentSummary?.amountDueNow,
            balancePaymentMethod: bookingCheck.balancePaymentMethod,
            balanceCollectedVia: bookingCheck.balanceCollectedVia,
            billingPaymentStatus:
                paymentSummary?.billingPaymentStatus || "Pending",
            bookingStatusId: 17,
        });
    } catch (err) {
        console.error(
            `[bookingDeliverToCustomer] payment flags failed for ${bookingId}:`,
            err.message
        );
    }

    return ResponseHelper.success(res, "Laundry Delivered to customer sucessfully", {
        bookingId: Number(bookingId),
        bookingStatusId: 17,
        ...paymentFlags,
        paymentSummary: paymentSummary
            ? {
                  ...paymentSummary,
                  ...paymentFlags,
                  paymentType: paymentFlags.paymentType || paymentSummary.paymentType,
              }
            : paymentSummary,
    });
}

//!-----------------------------Booking Step-2 When Agent/Driver Added the Services------------------------//

/*
 * Agent Add Services At the time of Invoice
 */

exports.driverAddSerivces = async (req, res) => {
    const {
        services,
        bookingId,
        zoneMinimumAmount,
        serviceCharge,
        timeZone,
        clientTimeZone,
    } = req.body;

    if (!Array.isArray(services) || services.length === 0) {
        throw new ValidationError("Invalid request. Please provide an array of services.");
    }

    const { date: currentDate, time: currentTime } = agentWallClockDateTime(
        timeZone,
        clientTimeZone
    );
    console.log("Invoice line timestamp (tz-aware):", currentDate, currentTime);

    // Fetch booking with zone and tip information
    const bookings = await booking.findByPk(bookingId, {
        include: [
            {
                model: zone,
                attributes: ['id', 'name', 'zoneAdminComission', 'agentCommissionPercent']
            },
            {
                model: tip,
                as: 'tips',
                attributes: ['id', 'amount'],
                required: false
            }
        ]
    });

    if (!bookings) {
        throw new NotFoundError("Booking not found");
    }

    assertBookingNotCancelledForAgent(bookings);

    // Get zone information directly from booking
    const zoneData = bookings.zone;
    if (!zoneData) {
        throw new NotFoundError("Zone information not found for this booking");
    }

    if (services.length > 0) {
        await invoiceManagementService.syncInvoiceDraftServiceLines({
            bookingId,
            services,
            currentDate,
            currentTime,
        });
    }

    const servicesSubtotal = await sumActiveBookingServicesSubtotal(bookingId);
    console.log(
        "[POST /agent/AgentAddSerivces] servicesSubtotal (qty-aware, incl. add-ons):",
        servicesSubtotal
    );

    const totals = await invoiceManagementService.calculateInvoiceTotals(
        bookings,
        bookingId,
        serviceCharge,
        zoneMinimumAmount
    );

    const {
        subTotal,
        total: discountedTotal,
        paymentSummary,
        existingDiscount,
        finalZoneAdminCommissionAmount,
        finalAgentEarningAmount,
    } = totals;

    console.log("Payment summary amountDueNow:", paymentSummary.amountDueNow);
    console.log("Total order amount:", subTotal);
    console.log("Existing Discount:", existingDiscount);

    if (isNaN(discountedTotal)) {
        throw new Error("Calculated total is NaN. Please check your input values.");
    }

    await billingDetails.update(
        {
            total: discountedTotal,
            discount: existingDiscount,
            paymentStatus: "Pending",
            zoneAdminCommission: finalZoneAdminCommissionAmount,
            agentEarning: finalAgentEarningAmount,
        },
        { where: { bookingId: bookingId } }
    );

    await bookingHistory.create({
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
        bookingId: bookingId,
        bookingStatusId: 9,
    });

    await booking.update(
        {
            orderAmount: discountedTotal,
            bookingStatusId: 9,
            subTotal,
            invoiceStatus: "finalized",
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

    // Send invoice ready email to customer + order invoice email to agent (non-blocking)
    try {
        const invoiceReadyMail = require('../../helper/invoiceReadyMail');
        const agentInvoiceMail = require('../../helper/agentInvoiceMail');
        const customerData = await users.findOne({
            where: { id: customerId },
            attributes: ['firstName', 'lastName', 'email']
        });
        const customerName = [customerData?.firstName, customerData?.lastName].filter(Boolean).join(' ') || 'Customer';

        if (customerData?.email) {
            await invoiceReadyMail({
                email: customerData.email,
                userName: customerData.firstName || 'Customer',
                orderNumber: bookings.orderTrackId || bookingId,
                finalAmount: discountedTotal.toFixed(2),
                currency: '£'
            });
            console.log('✅ Invoice ready email sent to:', customerData.email);
        }

        if (bookings.laundryShopId) {
            const shopAddress = await addressDb.findOne({
                where: { id: bookings.laundryShopId },
                attributes: ['id', 'userId'],
                include: [{
                    model: bussinessInformation,
                    attributes: ['shopName'],
                    required: false
                }]
            });

            if (shopAddress?.userId) {
                const agentData = await users.findOne({
                    where: { id: shopAddress.userId },
                    attributes: ['firstName', 'email']
                });

                if (agentData?.email) {
                    const shopName = shopAddress.bussinessInformations?.[0]?.shopName || 'Your shop';
                    await agentInvoiceMail({
                        email: agentData.email,
                        agentName: agentData.firstName || 'Agent',
                        shopName,
                        orderNumber: bookings.orderTrackId || bookingId,
                        customerName,
                        finalAmount: discountedTotal.toFixed(2),
                        currency: '£'
                    });
                    console.log('✅ Agent order invoice email sent to:', agentData.email);
                }
            }
        }
    } catch (emailError) {
        console.error('⚠️ Failed to send invoice emails (non-blocking):', emailError.message);
    }

    const paymentFlags = buildCollectPaymentFlags({
        paymentType: bookings.paymentType,
        paymentConfirmed: Boolean(bookings.paymentConfirmed),
        amountDueNow: paymentSummary?.amountDueNow,
        balancePaymentMethod: bookings.balancePaymentMethod,
        balanceCollectedVia: bookings.balanceCollectedVia,
        billingPaymentStatus: "Pending",
        bookingStatusId: 9,
    });

    return ResponseHelper.success(res, "Agent/Driver Added Detail", {
        bookingId,
        invoiceStatus: "finalized",
        paymentSummary: {
            ...paymentSummary,
            ...paymentFlags,
            paymentType: paymentFlags.paymentType,
        },
        servicesSubtotal,
        subTotal,
        total: discountedTotal,
        orderAmount: discountedTotal,
        ...paymentFlags,
    });
}


/*
 *  Agent Update Invoice
 */
exports.agentUpdateInvoice = async (req, res) => {
    const { bookingId, total, services, timeZone, clientTimeZone } = req.body

    console.log("Req.body--------------------->", req.body)

    const bookings = await booking.findByPk(bookingId);
    const wasStatus22 = Number(bookings?.bookingStatusId) === 22;
    const { date: currentDate, time: currentTime } = agentWallClockDateTime(
        timeZone,
        clientTimeZone
    );
    console.log("Update invoice history timestamp (tz-aware):", currentDate, currentTime);

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
    await booking.update({
        orderAmount: total,
        bookingStatusId: 22
    }, { where: { id: bookingId } });

    // Avoid duplicate status-22 history entries when booking is already 22.
    if (!wasStatus22) {
        await bookingHistory.create({
            date: currentDate,
            time: currentTime,
            bookingId: bookingId,
            bookingStatusId: 22,
        });
    }

    const customerId = bookings.customerId;
    let title = "Agent/Driver Updated Invoice";
    let body = "Your agent/driver has updated invoice";
    let data = {
        bookingId: bookingId,
        driverId: bookings.driverId,
    }
    sendNotification(customerId, title, body, data);


    return res.status(200).json({
        status: "1",
        message: "Booking services updated successfully",
        data: booking,
        error: ""
    });

}

/*
 * Save invoice as draft (no notification, no status change)
 */
exports.saveInvoiceDraft = async (req, res) => {
    const agentId = req.user.id;
    const result = await invoiceManagementService.saveInvoiceDraft({
        agentId,
        ...req.body,
    });
    return ResponseHelper.success(res, "Invoice saved as draft", result);
};

/*
 * Get saved invoice draft for agent booking
 */
exports.getInvoiceDraft = async (req, res) => {
    const agentId = req.user.id;
    const result = await invoiceManagementService.getInvoiceDraft({
        agentId,
        bookingId: req.params.bookingId,
    });
    return ResponseHelper.success(res, "Invoice draft retrieved", result);
};

/*
 * Update existing invoice draft (sync lines by id)
 */
exports.updateInvoiceDraft = async (req, res) => {
    const agentId = req.user.id;
    const result = await invoiceManagementService.updateInvoiceDraft({
        agentId,
        ...req.body,
    });
    return ResponseHelper.success(res, "Invoice draft updated", result);
};

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
                where: { status: true },
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
                        attributes: ["id", "name", "price", "status", "description", "barCode", "weightKg", "unitCount"]
                    },
                    {
                        model: customerSelectedServiceAddOn,
                        as: 'addOns',
                        required: false,
                        attributes: ['id', 'addOnServiceId', 'price', 'items', 'instructions'],
                        include: [
                            {
                                model: addOnServices,
                                as: 'addOnService',
                                attributes: ['id', 'name', 'price']
                            }
                        ]
                    },
                    {
                        model: customerSelectedServiceLine,
                        as: 'serviceLines',
                        required: false,
                        separate: true,
                        order: [['lineNum', 'ASC']],
                        attributes: ['id', 'lineNum', 'items'],
                        include: [
                            {
                                model: customerSelectedServiceAddOn,
                                as: 'addOns',
                                required: false,
                                attributes: ['id', 'addOnServiceId', 'price', 'items', 'instructions'],
                                include: [
                                    {
                                        model: addOnServices,
                                        as: 'addOnService',
                                        attributes: ['id', 'name', 'price']
                                    }
                                ]
                            }
                        ]
                    },
                    {
                        model: bookingPreference,
                        as: 'selectedServicePreferences',
                        required: false,
                        attributes: [
                            'id',
                            'customerSelectedServiceId',
                            'preferenceTypeId',
                            'preferenceValueId',
                            'parentPreferenceValueId',
                            'preferenceInstruction'
                        ],
                        include: [
                            {
                                model: preferenceTypes,
                                attributes: ['id', 'name']
                            },
                            {
                                model: preferenceValues,
                                attributes: ['id', 'value']
                            }
                        ]
                    }
                ],
                attributes: [
                    "id", "date", "time", "categoryPrice", "bookingId",
                    "categoryId", "serviceId", "subCategoryId", "items", "bags", "serviceInstruction", "status"
                ]
            },
            {
                model: OnHoldConfirmation,
                required: false,
                attributes: ["id", "description", "serviceId", "subCategoryId", "bookingId", "onHoldImg", "customerResponse"]
            },
            {
                model: billingDetails,
                as: 'billingDetail',
                required: false,
                attributes: ["upfrontAmount", "discount", "total", "zoneAdminCommission", "agentEarning", "serviceCharge", "categoryCharge", "pickupDriverEarning", "deliveryDriverEarning", "paymentStatus"]
            },
            {
                model: tip,
                as: 'tips',
                required: false,
                attributes: ["id", "amount"]
            },
            {
                model: bookingStatus,
                attributes: ["title", "description"]
            },
            {
                model: proofOfDeliveries,
                attributes: ['id', 'imgUpload', 'noOfItems', 'noOfBags', 'note', 'deliveryType', 'bookingId', 'userId']
            },
            {
                model: bookingPreference,
                as: 'bookingPreferences',
                required: false,
                attributes: [
                    'id',
                    'customerSelectedServiceId',
                    'preferenceTypeId',
                    'preferenceValueId',
                    'parentPreferenceValueId',
                    'preferenceInstruction'
                ],
                include: [
                    {
                        model: preferenceTypes,
                        attributes: ['id', 'name']
                    },
                    {
                        model: preferenceValues,
                        attributes: ['id', 'value']
                    }
                ]
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
    if (bookingData?.customer) {
        bookingData.customer = redactCustomerPhone(bookingData.customer);
    }
    const seenServiceIds = new Set();

    bookingData.customerSelectedServices = (bookingData.customerSelectedServices || [])
        .filter((item) => item.status !== false)
        .map(item => {
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

    // Determine customer response status from OnHoldConfirmations
    let customerHasResponded = null;

    if (bookingData.OnHoldConfirmations && bookingData.OnHoldConfirmations.length > 0) {
        // Check if any OnHoldConfirmation has customerResponse === true
        const hasConfirmed = bookingData.OnHoldConfirmations.some(
            item => item.customerResponse === true
        );

        customerHasResponded = hasConfirmed ? true : false;
    }
    // If no OnHoldConfirmation records exist, customerHasResponded remains null

    const servicesSubtotal = await sumActiveBookingServicesSubtotal(bookingId);
    bookingData.servicesSubtotal = servicesSubtotal;

    // Invoice-level item count = Σ(service.items × subCategory.unitCount).
    bookingData.totalItems = (bookingData.customerSelectedServices || []).reduce((sum, s) => {
        const qty = Number(s.items) || 0;
        const rawUnit = Number(s.subCategory?.unitCount);
        const unit = Number.isFinite(rawUnit) && rawUnit > 0 ? Math.floor(rawUnit) : 1;
        return sum + qty * unit;
    }, 0);

    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);

    const paymentFlags = buildCollectPaymentFlags({
        paymentType: bookingData.paymentType,
        paymentConfirmed: Boolean(bookingData.paymentConfirmed),
        amountDueNow: paymentSummary?.amountDueNow,
        balancePaymentMethod: bookingData.balancePaymentMethod,
        balanceCollectedVia: bookingData.balanceCollectedVia,
        billingPaymentStatus:
            paymentSummary?.billingPaymentStatus ||
            bookingData.billingDetail?.paymentStatus ||
            "Pending",
        bookingStatusId: bookingData.bookingStatusId,
    });

    // Stable COD fields on invoiceDetails (app reads this across statuses)
    bookingData.paymentType = paymentFlags.paymentType;
    bookingData.paymentConfirmed = paymentFlags.paymentConfirmed;
    bookingData.collectPaymentAfterDelivery =
        paymentFlags.collectPaymentAfterDelivery;
    bookingData.canProceedWithoutPayment = paymentFlags.canProceedWithoutPayment;
    bookingData.canCollectPaymentNow = paymentFlags.canCollectPaymentNow;
    bookingData.invoicePaymentWindowApplies =
        paymentFlags.invoicePaymentWindowApplies;
    bookingData.amountDueNow = paymentFlags.amountDueNow;

    if (bookingData.billingDetail) {
        bookingData.billingDetail = {
            ...bookingData.billingDetail,
            paymentStatus:
                paymentSummary?.billingPaymentStatus ||
                bookingData.billingDetail.paymentStatus ||
                "Pending",
            balanceDue: paymentSummary?.amountDueNow ?? 0,
        };
    }

    const paymentSummaryWithFlags = {
        ...paymentSummary,
        paymentType: paymentFlags.paymentType,
        paymentConfirmed: paymentFlags.paymentConfirmed,
        collectPaymentAfterDelivery: paymentFlags.collectPaymentAfterDelivery,
        canProceedWithoutPayment: paymentFlags.canProceedWithoutPayment,
        canCollectPaymentNow: paymentFlags.canCollectPaymentNow,
        invoicePaymentWindowApplies: paymentFlags.invoicePaymentWindowApplies,
        amountDueNow: paymentSummary?.amountDueNow ?? paymentFlags.amountDueNow,
    };

    return ResponseHelper.success(res, "Invoice Details", {
        invoiceDetails: bookingData,
        servicesSubtotal,
        totalItems: bookingData.totalItems,
        paymentSummary: paymentSummaryWithFlags,
        remainingTime,
        customerHasResponded,
        amountDueNow: paymentSummaryWithFlags.amountDueNow,
        ...paymentFlags,
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
                attributes: ["id", "name", "price", "unitCount"],
            },
        ],
        attributes: ['id', 'categoryPrice', 'items']
    });

    if (!customerServicesFind || customerServicesFind.length === 0) {
        return ResponseHelper.success(res, "No Customer Selected Services", {
            customerServices: [],
            totalAmount: 0,
            servicesSubtotal: 0,
        });
    }

    const lineIds = customerServicesFind.map((item) => item.id);
    let addOnTotal = 0;
    if (lineIds.length > 0) {
        const addOnRows = await customerSelectedServiceAddOn.findAll({
            where: { customerSelectedServiceId: lineIds },
            attributes: ['price'],
        });
        addOnTotal = addOnRows.reduce(
            (sum, addOn) => sum + getAddOnRowSubtotal(addOn),
            0
        );
    }

    const totalAmount = parseFloat(
        (
            customerServicesFind.reduce(
                (sum, item) =>
                    sum +
                    getLineSubtotal(item.categoryPrice, item.items),
                0
            ) + addOnTotal
        ).toFixed(2)
    );
    const servicesSubtotal = totalAmount;

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
        totalAmount,
        servicesSubtotal,
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


    const { date: currentDate, time: currentTime } = agentWallClockDateTime(
        req.body?.timeZone,
        req.body?.clientTimeZone
    );
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
                attributes: ['id', 'name', 'price', 'unitCount']
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
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
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
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
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
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
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
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
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

    const bulkArray = (permissionRole || [])
        .filter(ele => ele?.id)
        .map(ele => {
            const perms = ele?.permissions || {};
            return {
                featureId: ele.id,
                roleId: newRole.id,
                create: perms.create === true || perms.write === true,
                read: perms.read === true,
                update: perms.update === true || perms.write === true,
                delete: perms.delete === true || perms.write === true,
            };
        });

    if (bulkArray.length) {
        await permissions.bulkCreate(bulkArray);
    }

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

        const bulkArray = permissionRole
            .filter(ele => ele?.id)
            .map(ele => {
                const perms = ele?.permissions || {};
                return {
                    featureId: ele.id,
                    roleId,
                    create: perms.create === true || perms.write === true,
                    read: perms.read === true,
                    update: perms.update === true || perms.write === true,
                    delete: perms.delete === true || perms.write === true,
                };
            });

        if (bulkArray.length) {
            await permissions.bulkCreate(bulkArray);
        }
    }



    return ResponseHelper.success(res, "Role updated successfully", {});
}

/*
 * Get All Roles (agent app: Agent / Agent Employee / both features only; no Admin-only roles)
 */
exports.getAllRoles = async (req, res) => {
    const { getRoles } = await agentRolePermissionService.getAllRoles();
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
        attributes: ['id', 'create', 'read', 'update', 'delete', 'featureId', 'roleId']
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
    const agentId = req.user.id;

    let profileImg = null;
    if (req.file) {
        const tempProfileImg = req.file.path;
        profileImg = tempProfileImg.replace(/\\/g, '/');
    }

    const result = await agentEmployeeManagementService.addEmployee(
        req.body,
        profileImg,
        agentId
    );

    return ResponseHelper.success(res, result.message, result.data);
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
    const { findServices } = await agentServiceManagementService.getAgentServices(agentId);
    return ResponseHelper.success(res, "Services Found", { findServices });
}

/*
 *  Edit Service Status
*/
exports.editServiceStatus = async (req, res) => {
    const { serviceId, status } = req.body;
    const agentId = req.user.id;

    await agentServiceManagementService.editServiceStatus(
        { serviceId, status },
        agentId
    );

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
                paranoid: true,
                required: true,
            },
            {
                model: categories,
                attributes: ['id', 'name', 'status', 'image', 'description'],
                paranoid: true,
                required: true,
                include: [
                    {
                        model: subCategories,
                        attributes: ['id', 'name', 'status', 'price', 'unitCount', 'description', 'deletedAt'],
                        paranoid: true,
                        required: false
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
                subCategories: (item.category.subCategories || [])
                    .filter(sc => sc.deletedAt === null || sc.deletedAt === undefined)
                    .map(({ deletedAt, ...sc }) => sc)
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
                attributes: ["id", "name", "price", "unitCount"],
            },
        ],
        attributes: ['id', 'categoryPrice', 'items', 'bags', 'serviceInstruction']
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

    const lineIds = customerServices.map((item) => item.id);
    let addOnTotal = 0;
    if (lineIds.length > 0) {
        const addOnRows = await customerSelectedServiceAddOn.findAll({
            where: { customerSelectedServiceId: lineIds },
            attributes: ['price'],
        });
        addOnTotal = addOnRows.reduce(
            (sum, addOn) => sum + getAddOnRowSubtotal(addOn),
            0
        );
    }

    const totalAmount = parseFloat(
        (
            customerServices.reduce(
                (sum, item) =>
                    sum + getLineSubtotal(item.categoryPrice, item.items),
                0
            ) + addOnTotal
        ).toFixed(2)
    );

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
        items: item.items,
        bags: item.bags ?? null,
        serviceInstruction: item.serviceInstruction || null
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

    const platformOperationalHoursService = require("../../services/Admin/platformOperationalHoursService");
    const { getCountryContextFromShopUserId } = require("../../utils/countryTimeZone");
    const countryCtx = await getCountryContextFromShopUserId(userId);
    const platformOperationalHours =
        await platformOperationalHoursService.getAll(countryCtx.countryId);

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
        platformOperationalHours,
    };

    return ResponseHelper.success(res, "Information fetched", outObj);
}

exports.getAgentPlatformOperationalHours = async (req, res) => {
    const agentId = req.user?.id;
    if (!agentId) {
        throw new ValidationError("Unauthorized");
    }

    const platformOperationalHoursService = require("../../services/Admin/platformOperationalHoursService");
    const { getCountryContextFromShopUserId } = require("../../utils/countryTimeZone");
    const countryCtx = await getCountryContextFromShopUserId(agentId);
    const data = await platformOperationalHoursService.getAll(countryCtx.countryId);

    return ResponseHelper.success(
        res,
        "Platform operational hours retrieved successfully",
        data
    );
};

exports.printLabelData = async (req, res) => {
    const { bookingId } = req.params;

    const bookingData = await booking.findOne({
        where: { id: bookingId },
        include: [
            {
                model: users,
                as: 'customer',
                attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum']
            },
            {
                model: customerSelectedService,
                where: {
                    bookingId: bookingId,
                    status: true
                },
                required: false,
                attributes: ['id', 'serviceId', 'categoryId', 'subCategoryId', 'items', 'categoryPrice'],
                include: [
                    {
                        model: service,
                        attributes: ['id', 'name']
                    },
                    {
                        model: categories,
                        attributes: ['id', 'name']
                    },
                    {
                        model: subCategories,
                        attributes: ['id', 'name', 'price', 'unitCount', 'barCode']
                    },
                    {
                        model: customerSelectedServiceAddOn,
                        as: 'addOns',
                        required: false,
                        attributes: ['id', 'addOnServiceId', 'items', 'instructions'],
                        include: [
                            { model: addOnServices, as: 'addOnService', attributes: ['id', 'name'] }
                        ]
                    },
                    {
                        model: customerSelectedServiceLine,
                        as: 'serviceLines',
                        required: false,
                        separate: true,
                        order: [['lineNum', 'ASC']],
                        attributes: ['id', 'lineNum', 'items'],
                        include: [
                            {
                                model: customerSelectedServiceAddOn,
                                as: 'addOns',
                                required: false,
                                attributes: ['id', 'addOnServiceId', 'items', 'instructions'],
                                include: [
                                    { model: addOnServices, as: 'addOnService', attributes: ['id', 'name'] }
                                ]
                            }
                        ]
                    }
                ]
            }
        ]
    });

    if (!bookingData) {
        throw new NotFoundError("Booking not found");
    }

    const selectedServices = bookingData.customerSelectedServices || [];

    const buildAddOnsForTag = (lineAddOns) => {
        const list = (lineAddOns || []).map((a) => ({
            addOnServiceId: a.addOnServiceId,
            name: a.addOnService?.name || null,
            qty: Number(a.items) || 1,
            instructions: a.instructions || null,
        }));
        const display = list.length
            ? list.map((a) => `${a.name || 'Add-on'} x${a.qty}`).join(', ')
            : 'No add-ons';
        return { list, display };
    };

    // Tags per line = line quantity × catalog unitCount (min 1 each).
    // Each tag carries the add-ons of the line/split it belongs to.
    const rawTags = [];
    selectedServices.forEach((selectedService, serviceIndex) => {
        const subCategory = selectedService.subCategory;
        if (!subCategory) return;

        const parsedUnitCount = Number(subCategory.unitCount);
        const unitsPerItem =
            Number.isFinite(parsedUnitCount) && parsedUnitCount > 0
                ? Math.floor(parsedUnitCount)
                : 1;

        // Use stored line-split when present; else a single line for the whole qty.
        let lines = selectedService.serviceLines || [];
        if (!lines.length) {
            const parsedQuantity = Number(selectedService.items);
            const orderQuantity =
                Number.isFinite(parsedQuantity) && parsedQuantity > 0
                    ? Math.floor(parsedQuantity)
                    : 1;
            lines = [
                {
                    lineNum: 1,
                    items: orderQuantity,
                    addOns: selectedService.addOns || [],
                },
            ];
        }

        let copyIndexWithinSubCategory = 0;
        lines.forEach((line) => {
            const parsedLineQty = Number(line.items);
            const lineQuantity =
                Number.isFinite(parsedLineQty) && parsedLineQty > 0
                    ? Math.floor(parsedLineQty)
                    : 1;
            const piecesInLine = lineQuantity * unitsPerItem;
            const { list: addOns, display: addOnsDisplay } = buildAddOnsForTag(line.addOns);

            for (let i = 0; i < piecesInLine; i += 1) {
                copyIndexWithinSubCategory += 1;
                rawTags.push({
                    bookingId: bookingData.id,
                    orderTrackId: bookingData.orderTrackId,
                    customerId: bookingData.customer?.id || null,
                    customerName: `${bookingData.customer?.firstName || ''} ${bookingData.customer?.lastName || ''}`.trim(),
                    serviceId: selectedService.serviceId,
                    serviceName: selectedService.service?.name || null,
                    categoryId: selectedService.categoryId,
                    categoryName: selectedService.category?.name || null,
                    subCategoryId: selectedService.subCategoryId,
                    subCategoryName: subCategory.name,
                    subCategoryBarCode: subCategory.barCode || null,
                    subCategoryPrice: subCategory.price,
                    unitsPerItem,
                    unitCount: subCategory.unitCount,
                    serviceOrder: serviceIndex + 1,
                    serviceLineNum: line.lineNum,
                    copyIndexWithinLine: i + 1,
                    copyIndexWithinSubCategory,
                    addOns,
                    addOnsDisplay,
                });
            }
        });
    });

    const totalTags = rawTags.length;
    const tags = rawTags.map((tag, index) => {
        const serviceLabel = [tag.serviceName, tag.subCategoryName]
            .filter(Boolean)
            .join(' - ');
        return {
            ...tag,
            printIndex: index + 1,
            printDisplay: serviceLabel || `${index + 1} of ${totalTags}`,
            printDisplayCompact: tag.subCategoryName || `${index + 1}/${totalTags}`,
        };
    });

    return ResponseHelper.success(res, "Print Label Data", {
        bookingId: bookingData.id,
        orderTrackId: bookingData.orderTrackId,
        customer: bookingData.customer,
        totalTags,
        tags
    });
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
                attributes: ["id", "name", "price", "unitCount"],
            },
        ],
        attributes: ['categoryPrice', 'items'],
    });

    console.log("customerServicesFind===========>", customerServicesFind)

    // Restructure the data to group subCategories under services
    const groupedServices = customerServicesFind.reduce((acc, currentService) => {
        // Check if the service already exists in the accumulator
        let existingService = acc.find(service => service.service.id === currentService.service.id);

        // Only process if subCategory exists (it can be null)
        const subCategoryData = currentService.subCategory ? {
            id: currentService.subCategory.id,
            name: currentService.subCategory.name,
            price: currentService.subCategory.price
        } : null;

        if (existingService) {
            // If the service exists, add the subCategory to the subCategories list (if it exists)
            if (subCategoryData) {
                existingService.subCategories.push(subCategoryData);
            }
        } else {
            // If the service doesn't exist, create a new entry
            acc.push({
                service: {
                    id: currentService.service.id,
                    name: currentService.service.name
                },
                categoryPrice: currentService.categoryPrice,
                items: currentService.items,
                subCategories: subCategoryData ? [subCategoryData] : []
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
 * Order Summary Dashboard (Today/Week/Month/Year)
 */
exports.getOrderSummaryDashboard = async (req, res) => {
    const agentId = req.user.id;
    const period = (req.query.period || "today").toLowerCase();

    const supportedPeriods = ["today", "week", "month", "year"];
    if (!supportedPeriods.includes(period)) {
        throw new ValidationError("Invalid period. Use: today, week, month, or year.");
    }

    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    if (period === "today") {
        start.setHours(0, 0, 0, 0);
    } else if (period === "week") {
        // Monday as week start
        const day = start.getDay(); // 0=Sunday, 1=Monday...
        const diffToMonday = day === 0 ? 6 : day - 1;
        start.setDate(start.getDate() - diffToMonday);
        start.setHours(0, 0, 0, 0);
    } else if (period === "month") {
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
    } else if (period === "year") {
        start.setMonth(0, 1);
        start.setHours(0, 0, 0, 0);
    }

    const agentShopAddress = await addressDb.findOne({
        where: {
            userId: agentId,
            addressType: "LaundaryShopAddress"
        }
    });

    if (!agentShopAddress) {
        throw new NotFoundError("Agent shop address not found");
    }

    const orders = await booking.findAll({
        where: {
            laundryShopId: agentShopAddress.id,
            createdAt: {
                [Op.between]: [start, end]
            }
        },
        attributes: ["id"],
        include: [
            {
                model: bookingStatus,
                attributes: ["id", "title"]
            }
        ],
        raw: true,
        nest: true
    });

    const totals = {
        completed: 0,
        inProgress: 0,
        onHold: 0,
        cancelled: 0
    };

    for (const item of orders) {
        const statusTitle = (item.bookingStatus?.title || "").toLowerCase();

        if (statusTitle === "completed") {
            totals.completed += 1;
        } else if (statusTitle === "cancelled") {
            totals.cancelled += 1;
        } else if (statusTitle.includes("on hold") || statusTitle.includes("onhold")) {
            totals.onHold += 1;
        } else {
            totals.inProgress += 1;
        }
    }

    const totalOrders = orders.length;
    const toPercentage = (count) => {
        if (!totalOrders) return 0;
        return Number(((count / totalOrders) * 100).toFixed(1));
    };

    const response = {
        period,
        range: {
            startDate: start,
            endDate: end
        },
        totalOrders,
        statusBreakdown: totals,
        distribution: {
            completed: toPercentage(totals.completed),
            inProgress: toPercentage(totals.inProgress),
            onHold: toPercentage(totals.onHold),
            cancelled: toPercentage(totals.cancelled)
        }
    };

    return ResponseHelper.success(res, "Order summary dashboard data", response);
}

/*
 * Shop Performance Dashboard (Today/Week/Month/Year)
 */
exports.getShopPerformanceDashboard = async (req, res) => {
    const agentId = req.user.id;
    const period = (req.query.period || "today").toLowerCase();

    const supportedPeriods = ["today", "week", "month", "year"];
    if (!supportedPeriods.includes(period)) {
        throw new ValidationError("Invalid period. Use: today, week, month, or year.");
    }

    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    if (period === "today") {
        start.setHours(0, 0, 0, 0);
    } else if (period === "week") {
        const day = start.getDay();
        const diffToMonday = day === 0 ? 6 : day - 1;
        start.setDate(start.getDate() - diffToMonday);
        start.setHours(0, 0, 0, 0);
    } else if (period === "month") {
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
    } else if (period === "year") {
        start.setMonth(0, 1);
        start.setHours(0, 0, 0, 0);
    }

    const agentShopAddress = await addressDb.findOne({
        where: {
            userId: agentId,
            addressType: "LaundaryShopAddress"
        }
    });

    if (!agentShopAddress) {
        throw new NotFoundError("Agent shop address not found");
    }

    const orders = await booking.findAll({
        where: {
            laundryShopId: agentShopAddress.id,
            createdAt: {
                [Op.between]: [start, end]
            }
        },
        attributes: ["id", "createdAt", "updatedAt"],
        include: [
            {
                model: bookingStatus,
                attributes: ["title"]
            }
        ],
        raw: true,
        nest: true
    });

    const totalOrders = orders.length;
    let completedOrders = 0;
    let inProgressOrders = 0;
    let deliveredOrders = 0;
    let processingHoursTotal = 0;

    for (const item of orders) {
        const statusTitle = (item.bookingStatus?.title || "").toLowerCase();

        if (statusTitle === "completed") {
            completedOrders += 1;
            const createdAt = new Date(item.createdAt);
            const updatedAt = new Date(item.updatedAt);
            const hours = (updatedAt - createdAt) / (1000 * 60 * 60);
            if (!Number.isNaN(hours) && Number.isFinite(hours) && hours >= 0) {
                processingHoursTotal += hours;
            }
        } else if (statusTitle === "delivered") {
            deliveredOrders += 1;
            inProgressOrders += 1;
        } else if (statusTitle !== "cancelled") {
            inProgressOrders += 1;
        }
    }

    const safePercent = (num, den) => {
        if (!den) return 0;
        return Number(((num / den) * 100).toFixed(1));
    };

    // DB has no explicit punctuality timestamps; derive punctuality signal from completion flow
    const onTimePickup = safePercent(completedOrders + inProgressOrders, totalOrders);
    const onTimeDelivery = safePercent(completedOrders + deliveredOrders, totalOrders);

    const averageProcessingHours =
        completedOrders > 0
            ? Number((processingHoursTotal / completedOrders).toFixed(1))
            : 0;

    const performanceScore = safePercent(completedOrders, totalOrders);
    const rating = Number(((performanceScore / 100) * 5).toFixed(1));

    const topServicesRaw = await customerSelectedService.findAll({
        attributes: [
            "serviceId",
            [sequelize.fn("SUM", sequelize.col("items")), "totalItems"]
        ],
        include: [
            {
                model: booking,
                attributes: [],
                where: {
                    laundryShopId: agentShopAddress.id,
                    createdAt: {
                        [Op.between]: [start, end]
                    }
                }
            },
            {
                model: service,
                attributes: ["name"]
            }
        ],
        group: ["serviceId", "service.id", "service.name"],
        order: [[sequelize.literal("totalItems"), "DESC"]],
        limit: 3,
        raw: true,
        nest: true
    });

    const totalServiceItems = topServicesRaw.reduce(
        (sum, row) => sum + Number(row.totalItems || 0),
        0
    );

    const topServices = topServicesRaw.map((row, index) => {
        const items = Number(row.totalItems || 0);
        return {
            rank: index + 1,
            serviceId: row.serviceId,
            name: row.service?.name || "Unknown",
            items,
            percentage: totalServiceItems
                ? Number(((items / totalServiceItems) * 100).toFixed(1))
                : 0
        };
    });

    const response = {
        period,
        range: {
            startDate: start,
            endDate: end
        },
        performanceScore,
        punctuality: {
            onTimePickup,
            onTimeDelivery
        },
        processingAndRating: {
            averageProcessingHours,
            rating
        },
        totals: {
            totalOrders,
            completedOrders,
            inProgressOrders
        },
        topServices
    };

    return ResponseHelper.success(res, "Shop performance dashboard data", response);
}

/*
 * Earning Report Dashboard (Today/Week/Month/Year)
 */
exports.getEarningReportDashboard = async (req, res) => {
    const agentId = req.user.id;
    const period = (req.query.period || "today").toLowerCase();

    const supportedPeriods = ["today", "week", "month", "year"];
    if (!supportedPeriods.includes(period)) {
        throw new ValidationError("Invalid period. Use: today, week, month, or year.");
    }

    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    if (period === "today") {
        start.setHours(0, 0, 0, 0);
    } else if (period === "week") {
        const day = start.getDay();
        const diffToMonday = day === 0 ? 6 : day - 1;
        start.setDate(start.getDate() - diffToMonday);
        start.setHours(0, 0, 0, 0);
    } else if (period === "month") {
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
    } else if (period === "year") {
        start.setMonth(0, 1);
        start.setHours(0, 0, 0, 0);
    }

    const currentRangeMs = end.getTime() - start.getTime();
    const previousEnd = new Date(start.getTime() - 1);
    const previousStart = new Date(previousEnd.getTime() - currentRangeMs);

    const agentShopAddress = await addressDb.findOne({
        where: {
            userId: agentId,
            addressType: "LaundaryShopAddress"
        }
    });

    if (!agentShopAddress) {
        throw new NotFoundError("Agent shop address not found");
    }

    const fetchOrders = async (fromDate, toDate) => {
        return booking.findAll({
            where: {
                laundryShopId: agentShopAddress.id,
                createdAt: {
                    [Op.between]: [fromDate, toDate]
                }
            },
            attributes: ["id", "orderAmount", "createdAt"],
            include: [
                {
                    model: billingDetails,
                    as: "billingDetail",
                    attributes: ["total", "paymentStatus", "agentEarning"],
                    required: false
                },
                {
                    model: tip,
                    as: "tips",
                    attributes: ["amount"],
                    required: false
                }
            ]
        });
    };

    const currentOrders = await fetchOrders(start, end);
    const previousOrders = await fetchOrders(previousStart, previousEnd);

    const getOrderEarning = (order) => {
        const storedAgentEarning = Number(order.billingDetail?.agentEarning || 0);
        if (storedAgentEarning > 0) {
            return storedAgentEarning;
        }

        const billingTotal = Number(order.billingDetail?.total || 0);
        const fallbackAmount = Number(order.orderAmount || 0);
        const isPaid = order.billingDetail?.paymentStatus === "Paid";
        const gross =
            isPaid && billingTotal > 0
                ? billingTotal
                : fallbackAmount > 0
                  ? fallbackAmount
                  : billingTotal;

        return gross;
    };

    const currentEarnings = currentOrders.reduce(
        (sum, order) => sum + getOrderEarning(order),
        0
    );
    const previousEarnings = previousOrders.reduce(
        (sum, order) => sum + getOrderEarning(order),
        0
    );

    const growthPercentage = previousEarnings
        ? Number((((currentEarnings - previousEarnings) / previousEarnings) * 100).toFixed(1))
        : 0;

    const avgOrderValue = currentOrders.length
        ? Number((currentEarnings / currentOrders.length).toFixed(2))
        : 0;

    const tipsCollected = currentOrders.reduce((sum, order) => {
        const orderTips = (order.tips || []).reduce(
            (tipSum, oneTip) => tipSum + Number(oneTip.amount || 0),
            0
        );
        return sum + orderTips;
    }, 0);

    // Build chart buckets based on selected period
    const trendPoints = [];
    const labels = [];
    const bucketCount = 7;

    const bucketStart = new Date(end);
    if (period === "today") {
        bucketStart.setDate(bucketStart.getDate() - (bucketCount - 1));
        bucketStart.setHours(0, 0, 0, 0);
    } else if (period === "week") {
        bucketStart.setDate(bucketStart.getDate() - (7 * (bucketCount - 1)));
        bucketStart.setHours(0, 0, 0, 0);
    } else if (period === "month") {
        bucketStart.setMonth(bucketStart.getMonth() - (bucketCount - 1), 1);
        bucketStart.setHours(0, 0, 0, 0);
    } else {
        bucketStart.setFullYear(bucketStart.getFullYear() - (bucketCount - 1), 0, 1);
        bucketStart.setHours(0, 0, 0, 0);
    }

    const trendOrders = await fetchOrders(bucketStart, end);

    for (let i = 0; i < bucketCount; i++) {
        const from = new Date(bucketStart);
        const to = new Date(bucketStart);

        if (period === "today") {
            from.setDate(bucketStart.getDate() + i);
            to.setDate(bucketStart.getDate() + i);
            to.setHours(23, 59, 59, 999);
            labels.push(from.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }));
        } else if (period === "week") {
            from.setDate(bucketStart.getDate() + (i * 7));
            to.setDate(bucketStart.getDate() + (i * 7) + 6);
            to.setHours(23, 59, 59, 999);
            labels.push(`W${i + 1}`);
        } else if (period === "month") {
            from.setMonth(bucketStart.getMonth() + i, 1);
            to.setMonth(bucketStart.getMonth() + i + 1, 0);
            to.setHours(23, 59, 59, 999);
            labels.push(from.toLocaleDateString("en-US", { month: "short" }));
        } else {
            from.setFullYear(bucketStart.getFullYear() + i, 0, 1);
            to.setFullYear(bucketStart.getFullYear() + i, 11, 31);
            to.setHours(23, 59, 59, 999);
            labels.push(String(from.getFullYear()));
        }

        const bucketValue = trendOrders.reduce((sum, order) => {
            const createdAt = new Date(order.createdAt);
            if (createdAt >= from && createdAt <= to) {
                return sum + getOrderEarning(order);
            }
            return sum;
        }, 0);

        trendPoints.push(Number(bucketValue.toFixed(2)));
    }

    const response = {
        period,
        range: {
            startDate: start,
            endDate: end
        },
        summary: {
            currentEarnings: Number(currentEarnings.toFixed(2)),
            previousEarnings: Number(previousEarnings.toFixed(2)),
            growthPercentage
        },
        quickMetrics: {
            avgOrderValue,
            tipsCollected: Number(tipsCollected.toFixed(2))
        },
        earningsTrend: {
            labels,
            points: trendPoints
        }
    };

    return ResponseHelper.success(res, "Earning report dashboard data", response);
}

exports.getAgentWallet = async (req, res) => {
    const agentId = req.user.id;
    const data = await agentWalletService.getWalletSummary(agentId);
    return ResponseHelper.success(res, "Agent wallet summary", data);
};

exports.getAgentWalletTransactions = async (req, res) => {
    const agentId = req.user.id;
    const { page, limit } = req.query;
    const data = await agentWalletService.getWalletTransactions(agentId, {
        page,
        limit,
    });
    return ResponseHelper.success(res, "Agent wallet transactions", data);
};

exports.withdrawAgentWallet = async (req, res) => {
    const agentId = req.user.id;
    const { amount } = req.body || {};
    const data = await agentWithdrawalService.withdrawAgentEarnings(
        agentId,
        amount
    );
    return ResponseHelper.success(
        res,
        "Withdrawal transferred to Stripe Connect successfully",
        data
    );
};

exports.getAgentSettlement = async (req, res) => {
    const agentId = req.user.id;
    const data = await agentSettlementService.getAgentSettlementSummary(agentId);
    return ResponseHelper.success(res, "Agent settlement summary", data);
};

exports.submitCashRemittance = async (req, res) => {
    const agentId = req.user.id;
    const { amount, note } = req.body;
    const data = await agentSettlementService.submitCashRemittance(agentId, {
        amount,
        note,
    });
    return ResponseHelper.success(res, "Cash remittance submitted", data);
};


/*
  * Update Invoice  
*/
exports.updateInvoice = async (req, res) => {
    const { services, bookingId, timeZone, clientTimeZone, zoneMinimumAmount, serviceCharge } = req.body;

    console.log("[PATCH /agent/updateInvoice] agentId:", req.user?.id ?? null);
    console.log("[PATCH /agent/updateInvoice] request body:", JSON.stringify(req.body, null, 2));
    console.log("[PATCH /agent/updateInvoice] bookingId:", bookingId);
    console.log("[PATCH /agent/updateInvoice] timeZone:", timeZone, "clientTimeZone:", clientTimeZone);
    console.log(
        "[PATCH /agent/updateInvoice] services:",
        Array.isArray(services) ? `count=${services.length}` : typeof services,
        Array.isArray(services) ? JSON.stringify(services, null, 2) : services
    );

    if (!Array.isArray(services) || services.length === 0) {
        throw new ValidationError("Invalid request. Please provide an array of services.");
    }

    // Fetch booking with zone, tip, and billingDetails so serviceCharge
    // and zoneMinimumAmount are read from DB (not dependent on frontend sending them)
    const bookings = await booking.findByPk(bookingId, {
        include: [
            {
                model: zone,
                attributes: ['id', 'name', 'zoneAdminComission', 'agentCommissionPercent']
            },
            {
                model: tip,
                as: 'tips',
                attributes: ['id', 'amount'],
                required: false
            },
            {
                model: billingDetails,
                as: 'billingDetail',
                attributes: ['serviceCharge', 'upfrontAmount', 'discount'],
                required: false
            }
        ]
    });

    if (!bookings) {
        throw new NotFoundError("Booking not found");
    }

    assertBookingNotCancelledForAgent(bookings);

    const zoneData = bookings.zone;
    if (!zoneData) {
        throw new NotFoundError("Zone information not found for this booking");
    }

    const { date: currentDate, time: currentTime } = agentWallClockDateTime(
        timeZone,
        clientTimeZone
    );
    console.log("Update invoice timestamp (tz-aware):", currentDate, currentTime);

    // Save / update each service from the request (sync — no duplicate lines)
    if (services.length > 0) {
        await invoiceManagementService.syncInvoiceDraftServiceLines({
            bookingId,
            services,
            currentDate,
            currentTime,
        });
    }

    const servicesSubtotal = await sumActiveBookingServicesSubtotal(bookingId);
    console.log(
        "[PATCH /agent/updateInvoice] servicesSubtotal (qty-aware, incl. add-ons):",
        servicesSubtotal
    );

    const parsedServiceCharge =
        parseFloat(serviceCharge ?? bookings.billingDetail?.serviceCharge ?? 0) || 0;
    const parsedZoneMinimum =
        parseFloat(zoneMinimumAmount ?? bookings.billingDetail?.upfrontAmount ?? 0) || 0;

    const totals = await invoiceManagementService.calculateInvoiceTotals(
        bookings,
        bookingId,
        parsedServiceCharge,
        parsedZoneMinimum
    );

    const {
        subTotal,
        total: discountedTotal,
        paymentSummary,
        existingDiscount,
        finalZoneAdminCommissionAmount,
        finalAgentEarningAmount,
    } = totals;

    if (isNaN(discountedTotal)) {
        throw new Error("Calculated total is NaN. Please check your input values.");
    }

    await billingDetails.update(
        {
            total: discountedTotal,
            discount: existingDiscount,
            paymentStatus: "Pending",
            zoneAdminCommission: finalZoneAdminCommissionAmount,
            agentEarning: finalAgentEarningAmount,
        },
        { where: { bookingId: bookingId } }
    );

    await booking.update(
        {
            orderAmount: discountedTotal,
            subTotal,
        },
        { where: { id: bookingId } }
    );

    // Keep invoice-update timeline aligned with client-selected timezone.
    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingId,
        bookingStatusId: bookings.bookingStatusId,
    });

    return ResponseHelper.success(res, "Invoice Updated", {
        bookingId,
        paymentSummary,
        servicesSubtotal,
        subTotal,
        total: discountedTotal,
        orderAmount: discountedTotal,
        agentEarning: finalAgentEarningAmount,
        agentCommissionPercent: totals.agentCommissionPercent,
    });
}

//!---------------Recurring Functions-------------------------//


// Shared include config for zone queries
const agentZoneInclude = [
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
];

/**
 * Extract UK outcode from a full postcode.
 * e.g. "SW1A 1AA" → "SW1A", "NW1 1AA" → "NW1"
 */
const extractOutcode = (postcode) => {
    const normalized = postcode.trim().replace(/\s+/g, '').toUpperCase();
    return normalized.slice(0, normalized.length - 3);
};

/**
 * Find zone by postcode using JSON_CONTAINS.
 * Handles outcode (SW1A) and full postcode (SW1A 1AA) matching.
 */
const findZoneByPostcode = async (postcode) => {
    const normalized = postcode.trim().replace(/\s+/g, '').toUpperCase();
    const outcode = extractOutcode(normalized);

    console.log(`🔍 [Agent] Postcode lookup — full: "${normalized}", outcode: "${outcode}"`);

    const zones = await zone.findAll({
        where: {
            status: true,
            [Op.or]: [
                sequelize.where(
                    sequelize.fn('JSON_CONTAINS', sequelize.col('postcodes'), JSON.stringify(normalized)),
                    true
                ),
                sequelize.where(
                    sequelize.fn('JSON_CONTAINS', sequelize.col('postcodes'), JSON.stringify(outcode)),
                    true
                ),
            ]
        },
        include: agentZoneInclude,
        attributes: ["id", "zoneMinimumAmount", "serviceCharge", "status", "postcodes"],
    });

    console.log(`📮 [Agent] Postcode zone lookup found ${zones.length} zone(s)`);
    return zones;
};

/**
 * Find zones — 3-step:
 * 1. Reverse-geocode lat/lng → postcode via postcodes.io
 * 2. Match zone by postcode (outcode or full)
 * 3. Fallback to geometry ST_Contains
 */
const findZones = async (lat, lng) => {
    console.log(`[Agent] Finding zone for coordinates: { lat: ${lat}, lng: ${lng} }`);

    // ── Step 1: Reverse-geocode lat/lng → postcode ────────────────────────────
    let postcodeLookupResult = null;
    try {
        const response = await axios.get(
            `https://api.postcodes.io/postcodes?lon=${lng}&lat=${lat}`,
            { timeout: 5000 }
        );
        if (response.data.status === 200 && response.data.result && response.data.result.length > 0) {
            postcodeLookupResult = response.data.result[0].postcode;
            console.log(`📮 [Agent] Reverse geocode result: "${postcodeLookupResult}"`);
        }
    } catch (err) {
        console.warn("⚠️ [Agent] postcodes.io reverse geocode failed, falling back to geometry:", err.message);
    }

    // ── Step 2: Try postcode-based zone lookup ────────────────────────────────
    if (postcodeLookupResult) {
        const postcodeZones = await findZoneByPostcode(postcodeLookupResult);
        if (postcodeZones.length > 0) {
            console.log("✅ [Agent] Zone found via postcode lookup:", postcodeZones[0].id);
            return postcodeZones;
        }
        console.log("⚠️ [Agent] No zone matched by postcode, falling back to geometry...");
    }

    // ── Step 3: Fallback — geometry-based lookup (ST_Contains) ───────────────
    console.log("🗺️ [Agent] Trying geometry-based zone lookup...");
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
        include: agentZoneInclude,
        attributes: ["id", "zoneMinimumAmount", "serviceCharge", "status", "postcodes"],
    });

    if (findZone.length === 0) {
        throw new NotFoundError("No Zone found for these lat,lngs and coordinates");
    }

    console.log(`✅ [Agent] Zone found via geometry: ${findZone[0].id}`);
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
                    bookingStatusId: { [Op.notIn]: [1] } // exclude only not-yet-accepted (status 1); show Out for Delivery (13)
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
                    "bookingStatusId",
                    "pickupAttemptCount",
                    "pickupRescheduleRequired",
                    "deliveryAttemptCount",
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
            const enrichedBookings = bookings.map((b) => {
                const plain = b.toJSON ? b.toJSON() : b;
                const isPickupFailed =
                    plain.bookingStatusId === 3 &&
                    Boolean(plain.pickupRescheduleRequired);
                const isDeliveryFailed = plain.bookingStatusId === 15;
                const failedAttemptType = isDeliveryFailed
                    ? 'delivery'
                    : isPickupFailed
                        ? 'pickup'
                        : null;
                plain.displayStatus = isPickupFailed
                    ? { id: 3, title: 'Pickup Failed', description: 'A pickup attempt was unsuccessful' }
                    : plain.bookingStatus || null;
                // Explicit flags for agent app so it can detect failed attempts
                // even when bookingStatus remains "Awaiting Collection" (status 3).
                plain.attemptFlags = {
                    hasFailedAttempt: Boolean(failedAttemptType),
                    failedAttemptType,
                    pickupAttemptCount: Number(plain.pickupAttemptCount) || 0,
                    pickupRescheduleRequired: Boolean(
                        plain.pickupRescheduleRequired
                    ),
                    deliveryAttemptCount: Number(plain.deliveryAttemptCount) || 0,
                };
                return plain;
            });

            return {
                slot: `${collectionTimeFrom} - ${collectionTimeTo}`,
                bookingCount: bookingCount,
                bookings: enrichedBookings,
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
    const actorId = getPostcodeActorId(req);
    const result = await customerPostcodeService.getAddressesByPostcode(postcode, actorId);
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
    const actorId = getPostcodeActorId(req);
    const result = await customerPostcodeService.getAddressById(postcode, parseInt(index), actorId);
    return ResponseHelper.success(res, "Address fetched successfully", result);
};

/**
 * @route POST /api/agent/postcode/validate
 * @access Private (Agent)
 * @description Validate UK postcode via postcodes.io.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Object} - JSON response with validation result.
 */
exports.validatePostcode = async (req, res) => {
    const { postcode } = req.body;
    const result = await customerPostcodeService.verifyPostcodeWithPostcodesIo(postcode);
    return ResponseHelper.success(res, "Postcode validation result", result);
};

exports.autocompletePostcode = async (req, res) => {
    const query = req.query.q || req.query.query || "";
    const result = await customerPostcodeService.autocompletePostcode(query);
    return ResponseHelper.success(res, "Postcode suggestions fetched successfully", result);
};

/**
 * @route GET /api/agent/getActivePolicies
 * @access Private (Agent)
 * @description Get active cancellation, reschedule and no-show policies.
 */
exports.getActivePolicies = async (req, res) => {
    const zoneId = req.query.zoneId ? parseInt(req.query.zoneId) : null;
    const result = await activePoliciesService.getActivePolicies(zoneId);
    return ResponseHelper.success(res, "Active policies", result);
};

/**
 * GET /api/agent/getAllAddOnServices
 * Lists all add-on services from the admin-managed catalog (same data as admin getAllAddOnServices).
 */
exports.getAllAddOnServices = async (req, res) => {
    const rows = await addOnServicesService.getAllAddOnServices();
    return ResponseHelper.success(res, "Add-on services retrieved successfully", rows);
};

//!---------------------------------------------Notification APIs----------------------------------------//

/**
 * @route POST /api/agent/sendNotificationToCustomer
 * @access Private (Agent)
 * @description Send notification to customer using booking ID
 * @body {string} bookingId - The booking ID
 * @body {string} title - Notification title
 * @body {string} body - Notification body
 * @body {object} data - Additional data (optional)
 */
exports.sendNotificationToCustomer = async (req, res) => {
    const { bookingId, title, body, data } = req.body;
    const notificationService = require('../../services/Agent/notificationService');

    if (!bookingId || !title || !body) {
        throw new ValidationError('bookingId, title, and body are required');
    }

    const result = await notificationService.sendNotificationToCustomer(
        bookingId,
        title,
        body,
        data || {}
    );

    return ResponseHelper.success(res, "Notification sent to customer", result);
};

/**
 * Twilio SMS or click-to-call when agent reached pickup / delivery.
 * @route POST /agent/bookings/:bookingId/notify-customer
 * @body {string} leg - pickup | delivery
 * @body {string} [channel=sms] - sms | call
 */
exports.notifyCustomer = async (req, res) => {
    const customerNotifyService = require("../../services/Agent/customerNotifyService");
    const bookingId = req.params.bookingId || req.body.bookingId;
    const { leg, channel = "sms" } = req.body;

    if (!bookingId) {
        throw new ValidationError("bookingId is required");
    }
    if (!leg) {
        throw new ValidationError('leg is required ("pickup" or "delivery")');
    }

    const normalizedChannel = String(channel || "sms")
        .toLowerCase()
        .trim();
    if (normalizedChannel !== "sms" && normalizedChannel !== "call") {
        throw new ValidationError('channel must be "sms" or "call"');
    }

    const result = await customerNotifyService.notifyCustomer({
        bookingId,
        agentUserId: req.user.id,
        leg,
        channel: normalizedChannel,
    });

    const successMessage =
        normalizedChannel === "call"
            ? result?.message ||
              "Open dialer and call the masked number to reach the customer"
            : result?.message ||
              (result?.channel === "push" || result?.channel === "push_and_sms"
                  ? "Notification sent to customer"
                  : "SMS sent to customer");

    return ResponseHelper.success(res, successMessage, result);
};

/**
 * @route POST /api/agent/sendNotificationToAdmin
 * @access Private (Agent)
 * @description Send notification to admin(s)
 * @body {string} title - Notification title
 * @body {string} body - Notification body
 * @body {object} data - Additional data (optional)
 * @body {string} adminId - Optional specific admin ID
 */
exports.sendNotificationToAdmin = async (req, res) => {
    const { title, body, data, adminId } = req.body;
    const notificationService = require('../../services/Agent/notificationService');

    if (!title || !body) {
        throw new ValidationError('title and body are required');
    }

    const result = await notificationService.sendNotificationToAdmin(
        title,
        body,
        data || {},
        adminId
    );

    return ResponseHelper.success(res, "Notification sent to admin", result);
};

/**
 * @route POST /api/agent/sendNotificationToMultiple
 * @access Private (Agent)
 * @description Send notification to customer and/or admin using booking ID
 * @body {string} bookingId - The booking ID
 * @body {string} title - Notification title
 * @body {string} body - Notification body
 * @body {boolean} toCustomer - Send to customer (default: false)
 * @body {boolean} toAdmin - Send to admin (default: false)
 * @body {boolean} toZoneAdmin - Send to zone admin (default: false)
 * @body {object} data - Additional data (optional)
 */
exports.sendNotificationToMultiple = async (req, res) => {
    const { bookingId, title, body, toCustomer, toAdmin, toZoneAdmin, data } = req.body;
    const notificationService = require('../../services/Agent/notificationService');

    if (!bookingId || !title || !body) {
        throw new ValidationError('bookingId, title, and body are required');
    }

    if (!toCustomer && !toAdmin && !toZoneAdmin) {
        throw new ValidationError('At least one recipient type must be specified (toCustomer, toAdmin, or toZoneAdmin)');
    }

    const result = await notificationService.sendNotificationToMultiple(
        bookingId,
        title,
        body,
        {
            toCustomer: toCustomer || false,
            toAdmin: toAdmin || false,
            toZoneAdmin: toZoneAdmin || false
        },
        data || {}
    );

    return ResponseHelper.success(res, "Notifications sent", result);
};


//!---------------------------------------------Controllers Converted to Export Approach----------------------------------------//


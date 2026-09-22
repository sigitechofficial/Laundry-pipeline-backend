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
    UnauthorizedError,
    ForbiddenError,
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
const { bookingTipAmountFromTips, summarizeTips } = require("../../utils/bookingTips");
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
    computePhysicalTotalItems,
} = require("../../utils/invoiceLineTotals");
const dbModels = require("../../models");
const {
    buildRepairItemsInclude,
    hydrateRepairItemsForBooking,
} = require("../../utils/repairBookingInclude");
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

function recurringIntervalDaysFromLabel(value) {
    const key = String(value || "").trim().toLowerCase();
    if (key === "weekly") return 7;
    if (key === "every two weeks") return 14;
    if (key === "every four weeks") return 28;
    return 0;
}

function syncLiveTrackingSafe(bookingId, bookingStatusId, extras = {}) {
    try {
        const {
            syncLiveTrackingForBookingStatus,
        } = require("../../utils/liveTrackingRtdb");
        Promise.resolve(
            syncLiveTrackingForBookingStatus(bookingId, bookingStatusId, extras)
        ).catch((err) => {
            console.error(
                `[liveTracking] async sync failed booking=${bookingId}:`,
                err.message
            );
        });
    } catch (err) {
        console.error(
            `[liveTracking] sync import/call failed booking=${bookingId}:`,
            err.message
        );
    }
}

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
const {
    countActiveAssignedOrders,
    listActiveAssignedOrders,
} = require("../../utils/agentActiveOrders");
const invoiceManagementService = require("../../services/Agent/invoiceManagementService");
const {
    getCustomerDeclaredServices,
    getBookingRepairItems,
} = require("../../services/Agent/customerDeclaredServicesService");
const agentServiceManagementService = require("../../services/Agent/serviceManagementService");
const serviceManagementService = require("../../services/Admin/serviceManagementService");
const zoneCatalogService = require("../../services/Admin/zoneCatalogService");
const { sendNotification } = require("../../utils/notification");
const {
    assertBookingNotCancelledForAgent,
} = require("../../utils/assertBookingNotCancelledForAgent");
const { redactCustomerPhone } = require("../../utils/maskPhone");
const { buildAddOnsForTag } = require("../../utils/printLabelAddOns");
const {
    redactCustomerForFieldStaff,
    hideShopFinanceOnBooking,
    slimPaymentSummaryForFieldStaff,
} = require("../../utils/fieldDriverPrivacy");
const customerPostcodeService = require('../../services/Customer/customerPostcodeService');
const { getPostcodeActorId } = require('../../utils/postcodeActor');
const activePoliciesService = require('../../services/Admin/activePoliciesService');
const addOnServicesService = require('../../services/Admin/addOnServicesService');
const agentRolePermissionService = require('../../services/Agent/rolePermissionService');
const agentEmployeeManagementService = require('../../services/Agent/employeeManagementService');
const agentDriverManagementService = require('../../services/Agent/driverManagementService');
const agentBookingDeclineService = require('../../services/Agent/agentBookingDeclineService');
const agentOrderManagementService = require('../../services/Agent/orderManagementService');
const agentWalletService = require('../../services/Agent/agentWalletService');
const agentSettlementService = require('../../services/Agent/agentSettlementService');
const agentWithdrawalService = require('../../services/Agent/agentWithdrawalService');
const invoiceAutoChargeService = require('../../services/Agent/invoiceAutoChargeService');
const staffActivityService = require('../../services/Agent/staffActivityService');
const employeeCapabilityService = require('../../services/Agent/employeeCapabilityService');
const autoAssignService = require('../../services/Agent/autoAssignService');
const shopAssignmentPolicyService = require('../../services/Admin/shopAssignmentPolicyService');
const {
    resolveShopAgentId,
    resolveActorUserId,
    canManageShopOps,
} = require('../../utils/shopAgentContext');
const {
    respondIfAlreadyAdvanced,
    buildAlreadyUpdatedPayload,
} = require('../../utils/bookingStatusAlreadyUpdated');

function shopAgentIdFromReq(req) {
    return req.shopAgentId ?? resolveShopAgentId(req.user);
}

function actorUserIdFromReq(req) {
    return req.actorUserId ?? resolveActorUserId(req.user);
}

function actorCanManageShopOps(req) {
    if (typeof req.canManageShopOps === 'boolean') {
        return req.canManageShopOps;
    }
    return canManageShopOps(req.user);
}

/** Owner/manager board access (view orders / assign / accept) — not shopOps edit. */
function actorCanViewShopBoard(req) {
    const caps = req.capabilities || {};
    return (
        caps.canViewShopOrders === true ||
        caps.canAssignStaff === true ||
        caps.canAcceptOrders === true ||
        req.canViewShopOrders === true ||
        req.canAssignStaff === true ||
        req.canAcceptOrders === true ||
        req.isShopOwner === true ||
        req.isShopManager === true
    );
}

function actorCanAcceptOrders(req) {
    return (
        req.canAcceptOrders === true ||
        req.capabilities?.canAcceptOrders === true
    );
}

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

/**
 * Canonical "visible New bookings" for an agent — the SINGLE source of truth
 * shared by the New list AND the New badge count.
 *
 * Historically the New tab list (getBookingHome) applied per-row visibility
 * filters (agent must offer every selected service, pickup must fall inside
 * shop working hours, accept window must be open, orderExpireTime must exist,
 * booking not already declined) while the badge counters (bookingCounts /
 * fetchTabCounts) only ran the coarse SQL `where`. Result: badge showed N
 * (e.g. 3) while the list was empty. Both now derive from this function so
 * they can never drift again.
 *
 * @param {number} agentId
 * @param {object} [opts]
 * @param {string} [opts.timeZone]
 * @param {string} [opts.clientTimeZone]
 * @param {boolean} [opts.withDetails=false] include display joins (list) vs lean (count)
 * @returns {Promise<Array>} filtered plain booking rows visible to this agent
 */
async function fetchVisibleNewBookings(agentId, opts = {}) {
    const { timeZone, clientTimeZone, withDetails = false } = opts;

    const shopAddr = await addressDb.findOne({
        where: { userId: agentId, deletedAt: null },
        attributes: ["id", "zoneId"],
    });
    if (!shopAddr || !shopAddr.zoneId) return [];

    const agentShopId = shopAddr.id;
    const agentZone = shopAddr.zoneId;

    const { getCountryContextFromShopUserId } = require("../../utils/countryTimeZone");
    const agentCountryCtx = await getCountryContextFromShopUserId(agentId);
    const resolvedAgentTz = timeZone || agentCountryCtx.ianaTimeZone;

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const marketplaceHeld = await shopAssignmentPolicyService.isMarketplaceHeld(agentId);
    const declinedBookingIds =
        await agentBookingDeclineService.getDeclinedBookingIdsForAgent(agentId);

    const bookingWhere = {
        bookingStatusId: 1,
        zoneId: agentZone,
        laundryShopId: null,
        agentBroadcastHeld: { [Op.not]: true },
        createdAt: { [Op.gte]: twentyFourHoursAgo },
        [Op.or]: marketplaceHeld
            ? [{ adminAssignedShopId: agentShopId }]
            : [
                  { adminAssignedShopId: null },
                  { adminAssignedShopId: agentShopId },
              ],
        [Op.and]: [
            {
                [Op.or]: [
                    { preferredShopAgentId: null },
                    { preferredShopAgentId: agentId },
                    { preferredShopBroadcastDone: true },
                ],
            },
        ],
    };
    if (declinedBookingIds.length > 0) {
        bookingWhere.id = { [Op.notIn]: declinedBookingIds };
    }

    const detailIncludes = [
        {
            model: addressDb,
            as: "pickupAddress",
            attributes: ["id", "streetAddress", "district", "province", "postalcode", "lat", "lng", "addressType"],
            include: [
                { model: countries, attributes: ['id', 'name', 'shortName'] },
                { model: cities, attributes: ['id', 'name'] },
            ],
        },
        {
            model: users,
            as: 'customer',
            attributes: ['id', 'firstName', 'lastName', 'email', 'userTypeId', 'image', 'phoneNum'],
        },
        {
            model: users,
            as: 'driver',
            required: false,
            attributes: ['id', 'firstName', 'lastName', 'image'],
        },
        {
            model: users,
            as: 'deliveryDriver',
            required: false,
            attributes: ['id', 'firstName', 'lastName', 'image'],
        },
        {
            model: zone,
            attributes: ['id', 'name', 'zoneMinimumAmount', 'serviceCharge', 'currencyUnitId'],
        },
    ];

    const bookingData = await booking.findAll({
        where: bookingWhere,
        include: withDetails ? detailIncludes : [],
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
            "driverId",
            "deliveryDriverId",
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

    const out = [];
    for (const row of bookingData) {
        const plain = row.get({ plain: true });
        if (!plain.orderExpireTime) continue;

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
                timeZone,
                clientTimeZone
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
            clientTimeZone,
            agentCountryCtx.countryId
        );
        if (!pickupOk) continue;

        if (withDetails) {
            const minutesLeft = getAcceptWindowMinutesRemaining(
                getAcceptWindowAnchor(plain),
                plain.orderExpireTime,
                timeZone,
                clientTimeZone
            );
            out.push({
                ...plain,
                createdAt: plain.createdAt,
                orderExpireTime: formatOrderExpireTimeForApi(plain.orderExpireTime),
                acceptWindowMinutes: minutesLeft,
            });
        } else {
            out.push(plain);
        }
    }

    return out;
}

/*
 * Get Agent Order Home Api
 */

exports.getBookingHome = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);

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

    // Orders the agent has accepted and must still finish (or have admin
    // reassign) before they can close the shop / log out.
    const activeAssignedOrders = await countActiveAssignedOrders(
        agentId,
        userData.addressDb.id
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
            activeAssignedOrders,
        });
    }

    // Shop just opened — release any held bookings for this zone and notify agents immediately.
    const { releaseHeldBookingsForZone } = require("../../services/bookingHeldReleaseService");
    await releaseHeldBookingsForZone(agentZone);

    // Single source of truth for the New list — the badge counters
    // (bookingCounts / fetchTabCounts) call this same helper so list and
    // count can never diverge again.
    const bookingDataForResponse = await fetchVisibleNewBookings(agentId, {
        timeZone: queryTimeZone,
        clientTimeZone: queryClientTimeZone,
        withDetails: true,
    });

    return ResponseHelper.success(res, "Agent Orders fetched", {
        bookingData: bookingDataForResponse,
        isConnectAccountConnected,
        connectAccountId,
        agentShopOpen: true,
        zoneShopsOpen,
        platformOpenNow,
        afterHoursMode: !platformOpenNow,
        activeAssignedOrders,
    });
}

/**
 * GET /agent/activeOrdersCount
 * Authoritative count (+ short list) of orders the agent has accepted and
 * still owns. The app calls this before closing the shop or logging out so it
 * can block the action while work is outstanding (unless admin reassigns).
 */
exports.getActiveAssignedOrders = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const [count, orders] = await Promise.all([
        countActiveAssignedOrders(agentId),
        listActiveAssignedOrders(agentId),
    ]);
    return ResponseHelper.success(res, "Active assigned orders", {
        count,
        orders,
    });
};

exports.agentRejectOrder = async (req, res) => {
    if (!actorCanAcceptOrders(req)) {
        throw new ForbiddenError(
            'Only the shop owner or manager can decline new orders'
        );
    }
    const agentId = shopAgentIdFromReq(req);
    const { bookingId, reason } = req.body;

    if (!bookingId) {
        throw new ValidationError('bookingId is required');
    }
    if (!String(reason || '').trim()) {
        throw new ValidationError('A reason is required to decline an order');
    }

    const result = await agentBookingDeclineService.rejectBooking(agentId, bookingId, reason);

    const message = result.alreadyDeclined
        ? 'Booking already declined'
        : 'Booking declined successfully';

    return ResponseHelper.success(res, message, result);
};

exports.agentAcceptOrder = async (req, res) => {
    // Route gates with requireCapability('canAcceptOrders'); keep a soft guard
    const canAccept =
        req.canAcceptOrders === true ||
        req.capabilities?.canAcceptOrders === true;
    if (!canAccept) {
        throw new ForbiddenError(
            'Only the shop owner or manager can accept new orders. Ask them to assign jobs to you.'
        );
    }
    const agentId = shopAgentIdFromReq(req);
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
    const agentId = shopAgentIdFromReq(req);

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
            "createdAt",
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
            createdAt: b.createdAt,
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
    const agentId = shopAgentIdFromReq(req);
    const actorId = actorUserIdFromReq(req);

    let whereCondition = {};

    if (bookingId) {
        whereCondition.id = bookingId;
    } else {
        whereCondition.orderTrackId = orderTrackId;
    }
    console.log("orderDetailsById whereCondition:", whereCondition);

    const shopAddress = await addressDb.findOne({
        where: { userId: agentId, addressType: 'LaundaryShopAddress' },
        attributes: ['id'],
    });
    if (!shopAddress) {
        throw new NotFoundError('Address not found for agent');
    }

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
            {
                model: users,
                as: "driver",
                required: false,
                attributes: ["id", "firstName", "lastName", "image"],
            },
            {
                model: users,
                as: "deliveryDriver",
                required: false,
                attributes: ["id", "firstName", "lastName", "image"],
            },
        ],
    });

    if (!bookingfind) {
        throw new NotFoundError('Booking not found');
    }

    if (Number(bookingfind.laundryShopId) !== Number(shopAddress.id)) {
        throw new ForbiddenError('This order does not belong to your shop');
    }

    if (req.isShopEmployee && !actorCanViewShopBoard(req)) {
        const pickupId =
            bookingfind.driverId != null ? Number(bookingfind.driverId) : null;
        const deliveryId =
            bookingfind.deliveryDriverId != null
                ? Number(bookingfind.deliveryDriverId)
                : null;
        const pickupMine = pickupId != null && pickupId === Number(actorId);
        const deliveryMine =
            deliveryId != null && deliveryId === Number(actorId);
        if (!pickupMine && !deliveryMine) {
            throw new ForbiddenError(
                'You can only view orders assigned to you'
            );
        }
        const statusId = Number(bookingfind.bookingStatusId || 0);
        if (deliveryMine && !pickupMine && statusId < 12) {
            throw new ForbiddenError(
                'Delivery starts after the shop completes this order at the facility.'
            );
        }
    }

    let shopReview = null;
    try {
        const shopReviewService = require('../../services/Customer/shopReviewService');
        shopReview = await shopReviewService.getReviewByBookingId(bookingfind.id);
    } catch (err) {
        console.warn(
            '[orderDetailsById] shopReview attach failed:',
            err?.message || err
        );
    }

    if (bookingfind.bookingStatusId === 5) {
        const paymentType = normalizePaymentType(bookingfind.paymentType);
        const payload = { bookingfind, shopReview };
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

    const plain = bookingfind.toJSON ? bookingfind.toJSON() : bookingfind;
    return ResponseHelper.success(
        res,
        `Order Details for ${Object.keys(whereCondition)[0]}: ${Object.values(whereCondition)[0]}`,
        { ...plain, shopReview }
    );
}

/*
 *  Agent booking Filters
 */


/**
 * Agent Today/Tomorrow day-tab rules (relevantDate by phase):
 * - bookingStatusId 3..7 (pickup through in-transit to facility) → collectionDate
 * - bookingStatusId 8..16 (facility received / invoice / processing / delivery) → deliveryDate
 * "Done with Today pickup work" = status >= 8 (reachedAtDeliveryShopStatus).
 */
const AGENT_PICKUP_STATUSES = [3, 4, 5, 6, 7];
/** Invoice tab — at shop / services added. Once invoice is generated (10+) leave this tab. */
const AGENT_INVOICE_STATUSES = [8, 9];
/** Processing tab — invoice generated + washing. Completed at Facility (12) leaves this tab. */
const AGENT_PROCESSING_STATUSES = [10, 11];
/** Facility complete through delivered — Orders / day tabs (not Processing). */
const AGENT_POST_FACILITY_STATUSES = [12, 13, 14, 15, 16];
const AGENT_POST_PICKUP_STATUSES = [
    ...AGENT_INVOICE_STATUSES,
    ...AGENT_PROCESSING_STATUSES,
    ...AGENT_POST_FACILITY_STATUSES,
];
const AGENT_ALL_ACTIVE_STATUSES = [...AGENT_PICKUP_STATUSES, ...AGENT_POST_PICKUP_STATUSES];
/** Delivery-only drivers see/count a job only when it is ready to send. */
const AGENT_DELIVERY_VISIBLE_STATUSES = [12, 13, 14, 15, 16];

function fieldDriverAssignedJobScope(actorId) {
    return {
        [Op.or]: [
            {
                driverId: actorId,
                bookingStatusId: { [Op.in]: AGENT_PICKUP_STATUSES },
            },
            {
                deliveryDriverId: actorId,
                bookingStatusId: { [Op.in]: AGENT_DELIVERY_VISIBLE_STATUSES },
            },
        ],
    };
}

const agentDayTabWhere = (shopId, dayStart, dayEnd) => ({
    laundryShopId: shopId,
    [Op.or]: [
        {
            bookingStatusId: { [Op.in]: AGENT_PICKUP_STATUSES },
            collectionDate: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
        },
        {
            bookingStatusId: { [Op.in]: AGENT_POST_PICKUP_STATUSES },
            deliveryDate: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
        },
    ],
});

const agentRelevantDateOrder = [
    [literal(`CASE WHEN bookingStatusId IN (3,4,5,6,7) THEN collectionDate ELSE deliveryDate END IS NULL`), "ASC"],
    [literal(`CASE WHEN bookingStatusId IN (3,4,5,6,7) THEN collectionDate ELSE deliveryDate END`), "ASC"],
    [literal(`CASE WHEN bookingStatusId IN (3,4,5,6,7) THEN collectionTimeFrom ELSE deliveryTimeFrom END IS NULL`), "ASC"],
    [literal(`CASE WHEN bookingStatusId IN (3,4,5,6,7) THEN collectionTimeFrom ELSE deliveryTimeFrom END`), "ASC"],
];

/**
 * Slot bucket where: pickup phase uses collection time(+date); facility+ uses delivery time(+date).
 * When dayStart/dayEnd are omitted (current Flutter slots call), only pickup-phase rows are
 * returned so client OR-date merge cannot put status>=8 orders back on Today. Day tabs
 * (today/tomorrow) already return facility+ via agentDayTabWhere / deliveryDate.
 */
const agentSlotWhere = (laundryShopId, slotFrom, slotTo, dayStart, dayEnd) => {
    const pickupBranch = {
        bookingStatusId: { [Op.in]: AGENT_PICKUP_STATUSES },
        collectionTimeFrom: { [Op.gte]: slotFrom },
        collectionTimeTo: { [Op.lte]: slotTo },
    };
    if (dayStart && dayEnd) {
        pickupBranch.collectionDate = { [Op.gte]: dayStart, [Op.lt]: dayEnd };
        const deliveryBranch = {
            bookingStatusId: { [Op.in]: AGENT_POST_PICKUP_STATUSES },
            deliveryDate: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
            deliveryTimeFrom: { [Op.gte]: slotFrom },
            deliveryTimeTo: { [Op.lte]: slotTo },
        };
        return {
            laundryShopId,
            bookingStatusId: { [Op.in]: AGENT_ALL_ACTIVE_STATUSES },
            [Op.or]: [pickupBranch, deliveryBranch],
        };
    }
    return {
        laundryShopId,
        ...pickupBranch,
    };
};

exports.agentBookingFilters = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const actorId = Number(actorUserIdFromReq(req));
    // Drivers only see jobs assigned to them; owner/manager see the full shop board.
    const employeeStaffScope =
        req.isShopEmployee &&
        !actorCanViewShopBoard(req) &&
        Number.isFinite(actorId)
            ? fieldDriverAssignedJobScope(actorId)
            : null;
    const { filterType, filterDate } = req.query;

    // ── Shop address ────────────────────────────────────────────────────────
    const addressFound = await addressDb.findOne({
        where: { userId: agentId },
        attributes: ["id", "zoneId"],
    });

    if (!addressFound) {
        throw new NotFoundError("Address not found for agent");
    }

    const shopId  = addressFound.id;

    // Must AND staff scope — spreading Op.or would wipe day/slot date branches.
    const withStaffScope = (where) =>
        employeeStaffScope ? { [Op.and]: [where, employeeStaffScope] } : where;

    // ── Slots shortcut ───────────────────────────────────────────────────────
    if (filterType === "slots") {
        const results = {
            slots: await getSlotBookings(shopId, filterDate, employeeStaffScope),
        };
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
        "driverId", "deliveryDriverId",
        "createdAt",
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
            model: users, as: "driver", required: false,
            attributes: ["id", "firstName", "lastName", "image"],
        },
        {
            model: users, as: "deliveryDriver", required: false,
            attributes: ["id", "firstName", "lastName", "image"],
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
                // Same garments the customer booked — pickup proof must show
                // these as the Alteration "preferences", not only the note.
                buildRepairItemsInclude(dbModels, { separate: true }),
            ].filter(Boolean),
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

    // Nested include can miss rows after invoice CSS replacement (new CSS id).
    // Hydrate by serviceId so Alteration garments still reach pickup.
    const hideFinance = req.isShopEmployee && !req.canAccessInvoice;
    const decorateBoardBookings = async (rows) => {
        const plains = addDisplayStatus(rows);
        await Promise.all(
            plains.map(async (plain) => {
                if (plain?.id == null) return;
                plain.customerSelectedServices = await hydrateRepairItemsForBooking(
                    dbModels,
                    plain.id,
                    Array.isArray(plain.customerSelectedServices)
                        ? plain.customerSelectedServices
                        : []
                );
                if (plain.customer) {
                    plain.customer = hideFinance
                        ? redactCustomerForFieldStaff(plain.customer)
                        : redactCustomerPhone(plain.customer);
                }
                if (hideFinance) {
                    hideShopFinanceOnBooking(plain, { keepLiveServices: true });
                }
            })
        );
        return plains;
    };

    // ── Date helpers ─────────────────────────────────────────────────────────
    const todayStr         = moment().format("YYYY-MM-DD");
    const tomorrowStr      = moment().add(1, "day").format("YYYY-MM-DD");
    const dayAfterStr      = moment().add(2, "day").format("YYYY-MM-DD");

    // Status groups (shared constants — see AGENT_* above)
    const PICKUP_STATUSES = AGENT_PICKUP_STATUSES;
    const INVOICE_STATUSES = AGENT_INVOICE_STATUSES;
    const PROCESSING_STATUSES = AGENT_PROCESSING_STATUSES;
    const ALL_ACTIVE_STATUSES = AGENT_ALL_ACTIVE_STATUSES;

    // New list + New badge share ONE code path (fetchVisibleNewBookings) so the
    // count can never show orders the visible list would drop (services not
    // offered, pickup outside working hours, accept window closed, missing
    // orderExpireTime, already declined). Memoised so list + count reuse it.
    const queryTimeZone = req.query?.timeZone || req.body?.timeZone;
    const queryClientTimeZone = req.query?.clientTimeZone || req.body?.clientTimeZone;
    let _visibleNewRowsCache;
    const getVisibleNewRows = async () => {
        if (_visibleNewRowsCache === undefined) {
            _visibleNewRowsCache = await fetchVisibleNewBookings(agentId, {
                timeZone: queryTimeZone,
                clientTimeZone: queryClientTimeZone,
                withDetails: true,
            });
        }
        return _visibleNewRowsCache;
    };

    const fetchTabCounts = async () => {
        const hideNew = req.isShopEmployee && !actorCanAcceptOrders(req);
        const [countNew, countToday, countTomorrow, countOrders, countInvoice, countProcessing] = await Promise.all([
            hideNew ? Promise.resolve(0) : getVisibleNewRows().then((rows) => rows.length),
            booking.count({ where: withStaffScope(agentDayTabWhere(shopId, todayStr, tomorrowStr)) }),
            booking.count({ where: withStaffScope(agentDayTabWhere(shopId, tomorrowStr, dayAfterStr)) }),
            booking.count({
                where: withStaffScope({
                    laundryShopId: shopId,
                    bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES },
                }),
            }),
            booking.count({
                where: withStaffScope({
                    laundryShopId: shopId,
                    bookingStatusId: { [Op.in]: INVOICE_STATUSES },
                }),
            }),
            booking.count({
                where: withStaffScope({
                    laundryShopId: shopId,
                    bookingStatusId: { [Op.in]: PROCESSING_STATUSES },
                }),
            }),
        ]);
        return {
            new: countNew,
            today: countToday,
            tomorrow: countTomorrow,
            orders: countOrders,
            invoice: countInvoice,
            processing: countProcessing,
        };
    };

    const results = {};

    // ── NEW — unaccepted bookings in agent's zone ────────────────────────────
    // Drivers do not accept from the broadcast pool — owner/manager do.
    if (!filterType || filterType === "new") {
        if (req.isShopEmployee && !actorCanAcceptOrders(req)) {
            results.New = [];
        } else {
            results.New = await getVisibleNewRows();
        }
        if (filterType === "new") {
            results.counts = await fetchTabCounts();
            return ResponseHelper.success(res, "New bookings fetched", results);
        }
    }

    // ── TODAY — pickup phase by collectionDate OR facility+ by deliveryDate ─
    if (!filterType || filterType === "today") {
        const rows = await booking.findAll({
            where: withStaffScope(agentDayTabWhere(shopId, todayStr, tomorrowStr)),
            order: agentRelevantDateOrder,
            attributes: BOOKING_ATTRS,
            include: makeIncludes(),
        });
        results.Today = await decorateBoardBookings(rows);
        if (filterType === "today") {
            results.counts = await fetchTabCounts();
            return ResponseHelper.success(res, "Today's bookings fetched", results);
        }
    }

    // ── TOMORROW — same relevantDate rules for tomorrow's calendar day ───────
    if (!filterType || filterType === "tomorrow") {
        const rows = await booking.findAll({
            where: withStaffScope(agentDayTabWhere(shopId, tomorrowStr, dayAfterStr)),
            order: agentRelevantDateOrder,
            attributes: BOOKING_ATTRS,
            include: makeIncludes(),
        });
        results.Tomorrow = await decorateBoardBookings(rows);
        if (filterType === "tomorrow") {
            results.counts = await fetchTabCounts();
            return ResponseHelper.success(res, "Tomorrow's bookings fetched", results);
        }
    }

    // ── ORDERS — all active bookings (master list) ───────────────────────────
    if (!filterType || filterType === "orders") {
        const rows = await booking.findAll({
            where: withStaffScope({
                laundryShopId: shopId,
                bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES },
            }),
            order: agentRelevantDateOrder,
            attributes: BOOKING_ATTRS,
            include: makeIncludes(),
        });
        results.Orders = await decorateBoardBookings(rows);
        if (filterType === "orders") {
            results.counts = await fetchTabCounts();
            return ResponseHelper.success(res, "Orders fetched", results);
        }
    }

    // ── INVOICE — delivered to shop → services added (not yet generated) ─────
    if (!filterType || filterType === "invoice") {
        const rows = await booking.findAll({
            where: withStaffScope({
                laundryShopId: shopId,
                bookingStatusId: { [Op.in]: INVOICE_STATUSES },
            }),
            order: [
                [literal("deliveryDate IS NULL"), "ASC"],
                ["deliveryDate", "ASC"],
                [literal("deliveryTimeFrom IS NULL"), "ASC"],
                ["deliveryTimeFrom", "ASC"],
            ],
            attributes: BOOKING_ATTRS,
            include: makeIncludes(),
        });
        results.Invoice = await decorateBoardBookings(rows);
        if (filterType === "invoice") {
            results.counts = await fetchTabCounts();
            return ResponseHelper.success(res, "Invoice bookings fetched", results);
        }
    }

    // ── PROCESSING — invoice generated + washing ─────────────────────────────
    if (!filterType || filterType === "processing") {
        const rows = await booking.findAll({
            where: withStaffScope({
                laundryShopId: shopId,
                bookingStatusId: { [Op.in]: PROCESSING_STATUSES },
            }),
            order: [
                [literal("deliveryDate IS NULL"), "ASC"],
                ["deliveryDate", "ASC"],
                [literal("deliveryTimeFrom IS NULL"), "ASC"],
                ["deliveryTimeFrom", "ASC"],
            ],
            attributes: BOOKING_ATTRS,
            include: makeIncludes(),
        });
        results.Processing = await decorateBoardBookings(rows);
        if (filterType === "processing") {
            results.counts = await fetchTabCounts();
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
    results.counts = await fetchTabCounts();

    return ResponseHelper.success(res, "Booking Details Fetched for all filters", results);
};

/**
 * @route GET /agent/bookingCounts
 * Lightweight — returns only tab badge counts, no list data, no JOINs.
 */
exports.getBookingCounts = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const actorId = Number(actorUserIdFromReq(req));
    const employeeStaffScope =
        req.isShopEmployee &&
        !actorCanViewShopBoard(req) &&
        Number.isFinite(actorId)
            ? fieldDriverAssignedJobScope(actorId)
            : null;
    const withStaffScope = (where) =>
        employeeStaffScope ? { [Op.and]: [where, employeeStaffScope] } : where;

    const shopRow = await addressDb.findOne({
        where: { userId: agentId, deletedAt: null },
        attributes: ["id", "zoneId"],
    });
    if (!shopRow) return ResponseHelper.success(res, "Booking counts", { counts: { new: 0, today: 0, tomorrow: 0, orders: 0, invoice: 0, processing: 0 } });

    const shopId = shopRow.id;

    const todayStr        = moment().format("YYYY-MM-DD");
    const tomorrowStr     = moment().add(1, "day").format("YYYY-MM-DD");
    const dayAfterStr     = moment().add(2, "day").format("YYYY-MM-DD");
    const hideNew = req.isShopEmployee && !actorCanAcceptOrders(req);
    const queryTimeZone = req.query?.timeZone || req.body?.timeZone;
    const queryClientTimeZone = req.query?.clientTimeZone || req.body?.clientTimeZone;

    const [countNew, countToday, countTomorrow, countOrders, countInvoice, countProcessing] = await Promise.all([
        // Same visibility pipeline as the New list (getBookingHome) so the badge
        // never shows orders the list would drop. See fetchVisibleNewBookings.
        hideNew
            ? Promise.resolve(0)
            : fetchVisibleNewBookings(agentId, {
                  timeZone: queryTimeZone,
                  clientTimeZone: queryClientTimeZone,
              }).then((rows) => rows.length),
        booking.count({ where: withStaffScope(agentDayTabWhere(shopId, todayStr, tomorrowStr)) }),
        booking.count({ where: withStaffScope(agentDayTabWhere(shopId, tomorrowStr, dayAfterStr)) }),
        booking.count({
            where: withStaffScope({
                laundryShopId: shopId,
                bookingStatusId: { [Op.in]: AGENT_ALL_ACTIVE_STATUSES },
            }),
        }),
        booking.count({
            where: withStaffScope({
                laundryShopId: shopId,
                bookingStatusId: { [Op.in]: AGENT_INVOICE_STATUSES },
            }),
        }),
        booking.count({
            where: withStaffScope({
                laundryShopId: shopId,
                bookingStatusId: { [Op.in]: AGENT_PROCESSING_STATUSES },
            }),
        }),
    ]);

    return ResponseHelper.success(res, "Booking counts", {
        counts: { new: countNew, today: countToday, tomorrow: countTomorrow, orders: countOrders, invoice: countInvoice, processing: countProcessing },
    });
};

exports.getAgentOrderHistory = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const actorId = actorUserIdFromReq(req);
    const { status, page, limit, startDate, endDate, mine } = req.query;

    const options = {
        status,
        page,
        limit,
        startDate,
        endDate,
        canAccessInvoice: req.canAccessInvoice === true,
    };

    // Drivers / employees without shop-board view: only their legs.
    if (req.isShopEmployee && !actorCanViewShopBoard(req)) {
        options.staffUserId = actorId;
    } else if (mine === '1' || mine === 'true') {
        options.staffUserId = actorId;
    }

    const result = await agentOrderManagementService.getOrderHistory(agentId, options);

    return ResponseHelper.success(
        res,
        'Agent order history fetched successfully',
        result
    );
};

exports.invoiceDetailTab = async (req, res) => {
    if (req.isShopEmployee && !req.canAccessInvoice) {
        return ResponseHelper.success(res, "Invoice bookings", {
            All: [],
        });
    }
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
            "bookingStatusId",
            "createdAt",
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
                attributes: ['id', 'firstName', 'lastName', 'email', 'stripeCustomerId', 'defaultPaymentMethodId'],
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
                attributes: ['id', 'amount', 'source', 'paymentType', 'paidAt', 'createdAt'],
                required: false,
            },
        ],
    });

    if (!bookingfind) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingfind);

    if (
        await respondIfAlreadyAdvanced(res, {
            req,
            bookingId,
            currentStatusId: bookingfind.bookingStatusId,
            targetStatusId: 4,
        })
    ) {
        return;
    }

    if (bookingfind.bookingStatusId !== 3) {
        throw new ValidationError(
            "Booking is not ready for On the Way yet",
            {
                code: 'STATUS_NOT_READY',
                bookingId: Number(bookingId),
                bookingStatusId: bookingfind.bookingStatusId,
            }
        );
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

        syncLiveTrackingSafe(bookingId, 4, {
            agentId: bookingfind.driverId,
            customerId,
            bookingRow: bookingfind,
        });

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

    const resolvedPaymentMethodId =
        bookingfind.paymentMethodId ||
        bookingfind.customer?.defaultPaymentMethodId ||
        null;
    if (!resolvedPaymentMethodId) {
        throw new ValidationError("Payment method not found. Setup Intent was not completed properly.");
    }
    if (!bookingfind.paymentMethodId) {
        await booking.update(
            { paymentMethodId: resolvedPaymentMethodId },
            { where: { id: bookingId } }
        );
        bookingfind.paymentMethodId = resolvedPaymentMethodId;
    }

    const upfrontAmount = parseFloat(bookingfind.billingDetail?.upfrontAmount || 0) || 0;
    const serviceCharge = parseFloat(bookingfind.billingDetail?.serviceCharge || 0) || 0;
    const driverTip = bookingTipAmountFromTips(bookingfind.tips);
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

        syncLiveTrackingSafe(bookingId, 4, {
            agentId: bookingfind.driverId,
            customerId: bookingfind.customerId,
            bookingRow: bookingfind,
        });

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
            pickupPaymentIntentId: paymentIntent.id,
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

    syncLiveTrackingSafe(bookingId, 4, {
        agentId: bookingfind.driverId,
        customerId,
        bookingRow: bookingfind,
    });

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

    const bookingfind = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (!bookingfind) {
        throw new NotFoundError(`Booking with this id: ${bookingId} not exists`);
    }

    assertBookingNotCancelledForAgent(bookingfind);

    if (
        await respondIfAlreadyAdvanced(res, {
            req,
            bookingId,
            currentStatusId: bookingfind.bookingStatusId,
            targetStatusId: 5,
        })
    ) {
        return;
    }

    if (bookingfind.bookingStatusId !== 4) {
        throw new ValidationError("Your driver is still not out for pickup", {
            code: 'STATUS_NOT_READY',
            bookingId: Number(bookingId),
            bookingStatusId: bookingfind.bookingStatusId,
        });
    }

    const { confirmOutOfGeofence, overrideReason } = req.body || {};
    const { gateGeofenceAndRecord } = require('../../services/Agent/geofenceActionGate');
    await gateGeofenceAndRecord({
        bookingId,
        leg: 'pickup',
        action: 'arrived_pickup',
        driverLat,
        driverLng,
        geofenceBypassToken,
        confirmOutOfGeofence,
        overrideReason,
        actorUserId: actorUserIdFromReq(req),
        shopId: bookingfind.agentId || bookingfind.driverId,
    });

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

    syncLiveTrackingSafe(bookingId, 5, { reason: 'pickup_arrived' });

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
    // Only write back to booking totals on delivery (dropOff) proof.
    // Pickup proof overwrites the customer-declared totals which then leak into
    // the delivery display as a fallback — so we leave the booking fields alone
    // at pickup time; the proof entries themselves carry the pickup counts.
    if (normalizedDeliveryType === 'dropOff') {
        if (parsedItems !== undefined) {
            bookingUpdates.totalItems = parsedItems;
        }
        if (parsedBags !== undefined) {
            bookingUpdates.noOfBags = parsedBags;
            bookingUpdates.totalBags = parsedBags;
        }
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
    const actorId = actorUserIdFromReq(req);

    const bookingFind = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (!bookingFind) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingFind);

    if (
        await respondIfAlreadyAdvanced(res, {
            req,
            bookingId,
            currentStatusId: bookingFind.bookingStatusId,
            targetStatusId: 7,
        })
    ) {
        return;
    }

    if (bookingFind.bookingStatusId !== 5) {
        throw new ValidationError("Your driver is not reached yet", {
            code: 'STATUS_NOT_READY',
            bookingId: Number(bookingId),
            bookingStatusId: bookingFind.bookingStatusId,
        });
    }

    const {
        driverLat,
        driverLng,
        geofenceBypassToken,
        confirmOutOfGeofence,
        overrideReason,
    } = req.body || {};
    const { gateGeofenceAndRecord } = require('../../services/Agent/geofenceActionGate');
    await gateGeofenceAndRecord({
        bookingId,
        leg: 'pickup',
        action: 'complete_pickup',
        driverLat,
        driverLng,
        geofenceBypassToken,
        confirmOutOfGeofence,
        overrideReason,
        actorUserId: actorId,
        shopId: bookingFind.agentId || bookingFind.driverId,
    });

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

    try {
        const { recordLegCompletion } = require('../../utils/legCompletion');
        await recordLegCompletion({
            bookingId,
            leg: 'pickup',
            actorUserId: actorId,
            fallbackAssigneeId: bookingFind.driverId,
        });
    } catch (err) {
        console.warn(
            '[agentInspectionStatus] legCompletion failed:',
            err?.message || err
        );
    }

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

    if (
        await respondIfAlreadyAdvanced(res, {
            req,
            bookingId,
            currentStatusId: bookingCheck.bookingStatusId,
            targetStatusId: 8,
        })
    ) {
        return;
    }

    if (bookingCheck.bookingStatusId !== 7) {
        throw new ValidationError("Booking is still not In Transit to Facility", {
            code: 'STATUS_NOT_READY',
            bookingId: Number(bookingId),
            bookingStatusId: bookingCheck.bookingStatusId,
        });
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

    return ResponseHelper.success(res, "Driver Reached At Laundry Shop", {
        bookingId: Number(bookingId),
        bookingStatusId: 8,
    });
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

    const pickupPaymentIntentId =
        invoiceAutoChargeService.resolvePickupPaymentIntentId(
            bookingRow,
            paymentIntent.id
        );

    const balanceSuccessUpdate = {
        orderAmount: fullOrderTotal,
        paymentIntentId: paymentIntent.id,
        balanceCollectedVia: "card",
        paymentConfirmed: true,
        autoChargeStatus: "succeeded",
        paymentDeliveryGate: "open",
        lastPaymentFailureCode: null,
        lastPaymentFailureMessage: null,
        lastPaymentFailureAt: null,
    };
    if (pickupPaymentIntentId) {
        balanceSuccessUpdate.pickupPaymentIntentId = pickupPaymentIntentId;
    }

    await booking.update(balanceSuccessUpdate, { where: { id: bookingId } });

    await tryCreditAgentWallet(bookingId);

    const updatedPaymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const refreshed = await booking.findByPk(bookingId);
    const paymentGateFlags = invoiceAutoChargeService.buildPaymentGateFlags(
        refreshed,
        0
    );

    return ResponseHelper.success(res, "Balance payment charged successfully", {
        bookingId,
        paymentIntentId: paymentIntent.id,
        chargeAmount,
        paymentSummary: updatedPaymentSummary,
        ...paymentGateFlags,
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

    const updatePayload = { balancePaymentMethod: normalized };
    if (normalized === "cash") {
        updatePayload.autoChargeStatus =
            bookingRow.autoChargeStatus === "succeeded"
                ? "succeeded"
                : "cancelled";
        updatePayload.autoChargeDueAt = null;
        updatePayload.paymentDeliveryGate = "cleared_cash";
    } else if (normalized === "card") {
        updatePayload.paymentDeliveryGate = "open";
    }
    await bookingRow.update(updatePayload);

    if (normalized === "card") {
        await invoiceAutoChargeService.scheduleInvoiceAutoCharge(bookingId, {
            forceReschedule: true,
        });
    }

    const updatedPaymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const refreshed = await booking.findByPk(bookingId);
    const paymentGateFlags = invoiceAutoChargeService.buildPaymentGateFlags(
        refreshed,
        updatedPaymentSummary?.amountDueNow ?? 0
    );

    return ResponseHelper.success(res, "Balance payment method updated", {
        bookingId: Number(bookingId),
        balancePaymentMethod: normalized,
        paymentSummary: {
            ...updatedPaymentSummary,
            ...paymentGateFlags,
        },
        ...paymentGateFlags,
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
        await tryCreditAgentWallet(bookingId);
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
 *   Laundry Status Updated Invoice Generated and Status goes to In-Processing.
 *   Cash COD: proceed unpaid (collect after delivery via recordCashPayment).
 *   Card: proceed unpaid — balance auto-charged ~2h after finalize; OFD gated on payment/admin.
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

    // Already moved to Processing by AgentAddSerivces — Proceed is idempotent
    if (bookingCheck.bookingStatusId === 11 || bookingCheck.bookingStatusId === 12) {
        const paymentType = normalizePaymentType(bookingCheck.paymentType);
        const balanceMethod = resolveBalancePaymentMethod(bookingCheck);
        const paymentSummary =
            await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
        const amountDue = Number(paymentSummary?.amountDueNow ?? 0);
        const paymentFlags = buildCollectPaymentFlags({
            paymentType,
            paymentConfirmed: Boolean(bookingCheck.paymentConfirmed),
            amountDueNow: amountDue,
            balancePaymentMethod: balanceMethod,
            balanceCollectedVia: bookingCheck.balanceCollectedVia,
            billingPaymentStatus:
                bookingCheck.billingDetail?.paymentStatus || "Pending",
            bookingStatusId: bookingCheck.bookingStatusId,
        });
        const paymentGateFlags = invoiceAutoChargeService.buildPaymentGateFlags(
            bookingCheck,
            amountDue
        );
        const alreadyPayload = await buildAlreadyUpdatedPayload({
            req,
            bookingId,
            currentStatusId: bookingCheck.bookingStatusId,
            targetStatusId: 11,
            extraData: {
                ...paymentFlags,
                ...paymentGateFlags,
                paymentSummary: {
                    ...paymentSummary,
                    ...paymentFlags,
                    ...paymentGateFlags,
                },
            },
        });
        return ResponseHelper.success(res, "Booking already in processing", alreadyPayload);
    }

    // Past processing (wash complete / OFD / delivered) — sync client to current status
    if (
        await respondIfAlreadyAdvanced(res, {
            req,
            bookingId,
            currentStatusId: bookingCheck.bookingStatusId,
            targetStatusId: 11,
        })
    ) {
        return;
    }

    // 8 = Delivered to shop, 9 = services added, 10 = invoice generated (retry / legacy)
    const allowedForInvoiceGenerate = [8, 9, 10];
    if (!allowedForInvoiceGenerate.includes(bookingCheck.bookingStatusId)) {
        throw new ValidationError(
            "Booking must be at the laundry shop (invoice stage) before generating the invoice",
            {
                code: 'STATUS_NOT_READY',
                bookingId: Number(bookingId),
                bookingStatusId: bookingCheck.bookingStatusId,
            }
        );
    }

    const paymentType = normalizePaymentType(bookingCheck.paymentType);
    const balanceMethod = resolveBalancePaymentMethod(bookingCheck);
    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    const amountDue = Number(paymentSummary?.amountDueNow ?? 0);
    const billingPaid = bookingCheck.billingDetail?.paymentStatus === "Paid";
    const isFullyPaid = billingPaid || amountDue <= 0.02;

    if (isFullyPaid) {
        await booking.update(
            {
                bookingStatusId: 11,
                paymentConfirmed: true,
                autoChargeStatus: "succeeded",
                paymentDeliveryGate: "open",
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
        // Card auto-charge OR cash COD: advance to Processing without collecting now
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

        await invoiceAutoChargeService.scheduleInvoiceAutoCharge(bookingId);
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

    const refreshed = await booking.findByPk(bookingId);
    const paymentGateFlags = invoiceAutoChargeService.buildPaymentGateFlags(
        refreshed,
        isFullyPaid ? 0 : amountDue
    );

    return ResponseHelper.success(res, "Driver Reached At Laundry Shop", {
        bookingId: Number(bookingId),
        bookingStatusId: 11,
        ...paymentFlags,
        ...paymentGateFlags,
        paymentSummary: {
            ...paymentSummary,
            ...paymentFlags,
            ...paymentGateFlags,
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

    if (
        await respondIfAlreadyAdvanced(res, {
            req,
            bookingId,
            currentStatusId: bookingCheck.bookingStatusId,
            targetStatusId: 12,
        })
    ) {
        return;
    }

    if (bookingCheck.bookingStatusId !== 11) {
        throw new ValidationError("Booking is still not In Processing or Invoice Not Generated", {
            code: 'STATUS_NOT_READY',
            bookingId: Number(bookingId),
            bookingStatusId: bookingCheck.bookingStatusId,
        });
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
    return ResponseHelper.success(res, "Laundry Has Been Washed At Shop", {
        bookingId: Number(bookingId),
        bookingStatusId: 12,
    });
}

/*
 *   Laundry Status Updated That Laundry is Out for Delivery to Customer
 *   Card unpaid: OFD auto-retry once; on fail block until admin clears.
 */
exports.laundryDeliverToCustomer = async (req, res) => {
    const { bookingId } = req.params;

    const queryDriverId = req.query.driverId
        ? Number(req.query.driverId)
        : null;
    const actorId = actorUserIdFromReq(req);
    const shopOwnerId = shopAgentIdFromReq(req);

    const bookingCheck = await booking.findOne({ where: { id: bookingId } });
    if (!bookingCheck) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }
    assertBookingNotCancelledForAgent(bookingCheck);

    // Already OFD or further — sync client; never reset status / re-run payment gate
    if (
        await respondIfAlreadyAdvanced(res, {
            req,
            bookingId,
            currentStatusId: bookingCheck.bookingStatusId,
            targetStatusId: 13,
            extraData: {
                deliveryDriverId: bookingCheck.deliveryDriverId,
            },
        })
    ) {
        return;
    }

    if (bookingCheck.bookingStatusId !== 12) {
        throw new ValidationError(
            "Laundry must be completed at facility before Out for Delivery",
            {
                code: 'STATUS_NOT_READY',
                bookingId: Number(bookingId),
                bookingStatusId: bookingCheck.bookingStatusId,
            }
        );
    }

    let ofdGate = null;
    try {
        ofdGate = await invoiceAutoChargeService.assertCanOutForDelivery(
            bookingId,
            { agentUserId: shopOwnerId }
        );
    } catch (gateErr) {
        if (gateErr.code === "PAYMENT_WAITING_ADMIN" || gateErr.statusCode === 402) {
            throw new ValidationError(
                gateErr.message ||
                    "Please wait for admin instruction. Payment still needs to be processed.",
                {
                    code: "PAYMENT_WAITING_ADMIN",
                    ...(gateErr.paymentFlags || {}),
                }
            );
        }
        if (gateErr.statusCode === 404) {
            throw new NotFoundError(gateErr.message);
        }
        throw gateErr;
    }

    const currentDeliveryId =
        bookingCheck.deliveryDriverId != null
            ? Number(bookingCheck.deliveryDriverId)
            : null;
    const deliveryShopHeld =
        currentDeliveryId == null ||
        currentDeliveryId === Number(shopOwnerId);

    let deliveryAssignee = currentDeliveryId;
    if (queryDriverId && Number.isFinite(queryDriverId)) {
        deliveryAssignee = queryDriverId;
    } else if (deliveryShopHeld) {
        // Owner/manager OFD, or pickup driver claiming shop-held delivery.
        deliveryAssignee = Number(actorId);
    }

    await booking.update(
        {
            bookingStatusId: 13,
            deliveryDriverId: deliveryAssignee,
        },
        { where: { id: bookingId } }
    );

    await bookingHistory.create({
        date: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).date,
        time: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone).time,
        bookingId: bookingId,
        bookingStatusId: 13,
    });

    const customerId = bookingCheck.customerId;
    sendNotification(
        customerId,
        "Out for delivery",
        "Your laundry is out for delivery",
        {
            bookingId: String(bookingId),
            type: "OUT_FOR_DELIVERY",
            driverId: String(deliveryAssignee || actorId),
        }
    ).catch(() => {});

    syncLiveTrackingSafe(bookingId, 13, {
        agentId: deliveryAssignee || actorId,
        customerId,
        bookingRow: bookingCheck,
    });

    return ResponseHelper.success(
        res,
        "Driver updated and out for Deliver Laundry to Customer",
        {
            bookingStatusId: 13,
            deliveryDriverId: deliveryAssignee,
            chargedOnOfd: Boolean(ofdGate?.chargedOnOfd),
            ...(ofdGate?.flags || {}),
        }
    );
}

/*
 *   Driver Reached at customer Destination
 */
exports.driverReachedForDelivery = async (req, res) => {
    const { bookingId } = req.params;
    const { driverLat, driverLng, geofenceBypassToken } = req.body;

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (!bookingCheck) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingCheck);

    if (
        await respondIfAlreadyAdvanced(res, {
            req,
            bookingId,
            currentStatusId: bookingCheck.bookingStatusId,
            targetStatusId: 14,
        })
    ) {
        return;
    }

    if (bookingCheck.bookingStatusId !== 13) {
        throw new ValidationError("Driver is not out to deliver your laundry", {
            code: 'STATUS_NOT_READY',
            bookingId: Number(bookingId),
            bookingStatusId: bookingCheck.bookingStatusId,
        });
    }

    const { confirmOutOfGeofence, overrideReason } = req.body || {};
    const { gateGeofenceAndRecord } = require('../../services/Agent/geofenceActionGate');
    await gateGeofenceAndRecord({
        bookingId,
        leg: 'delivery',
        action: 'arrived_delivery',
        driverLat,
        driverLng,
        geofenceBypassToken,
        confirmOutOfGeofence,
        overrideReason,
        actorUserId: actorUserIdFromReq(req),
        shopId: bookingCheck.agentId || bookingCheck.deliveryDriverId || bookingCheck.driverId,
    });

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

    syncLiveTrackingSafe(bookingId, 14, { reason: 'delivery_arrived' });

    const recurringGapDays = recurringIntervalDaysFromLabel(bookingCheck.frequency);
    const recurringHint = recurringGapDays > 0
        ? {
            recurringEnabled: true,
            requiresReturnPickup: true,
            frequency: bookingCheck.frequency,
            nextCollectionDate: (() => {
                const base = new Date(bookingCheck.collectionDate);
                if (!Number.isFinite(base.getTime())) return null;
                base.setUTCDate(base.getUTCDate() + recurringGapDays);
                return base.toISOString().slice(0, 10);
            })(),
        }
        : {
            recurringEnabled: false,
            requiresReturnPickup: false,
            frequency: bookingCheck.frequency || "Just Once",
            nextCollectionDate: null,
        };

    return ResponseHelper.success(res, "Driver reached for delivery", {
        bookingId: Number(bookingId),
        bookingStatusId: 14,
        recurringHint,
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
    const actorId = actorUserIdFromReq(req);

    const bookingCheck = await booking.findOne({
        where: {
            id: bookingId,
        },
    });

    if (!bookingCheck) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingCheck);

    if (
        await respondIfAlreadyAdvanced(res, {
            req,
            bookingId,
            currentStatusId: bookingCheck.bookingStatusId,
            targetStatusId: 17,
        })
    ) {
        return;
    }

    if (bookingCheck.bookingStatusId !== 14) {
        throw new ValidationError("Driver not reached yet at customer destination", {
            code: 'STATUS_NOT_READY',
            bookingId: Number(bookingId),
            bookingStatusId: bookingCheck.bookingStatusId,
        });
    }

    const {
        driverLat,
        driverLng,
        geofenceBypassToken,
        confirmOutOfGeofence,
        overrideReason,
    } = req.body || {};
    const { gateGeofenceAndRecord } = require('../../services/Agent/geofenceActionGate');
    await gateGeofenceAndRecord({
        bookingId,
        leg: 'delivery',
        action: 'complete_delivery',
        driverLat,
        driverLng,
        geofenceBypassToken,
        confirmOutOfGeofence,
        overrideReason,
        actorUserId: actorId,
        shopId: bookingCheck.agentId || bookingCheck.deliveryDriverId || bookingCheck.driverId,
    });

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

    try {
        const { recordLegCompletion } = require('../../utils/legCompletion');
        await recordLegCompletion({
            bookingId,
            leg: 'delivery',
            actorUserId: actorId,
            fallbackAssigneeId: bookingCheck.deliveryDriverId,
        });
    } catch (err) {
        console.warn(
            '[bookingDeliverToCustomer] legCompletion failed:',
            err?.message || err
        );
    }

    const customerId = bookingCheck.customerId;
    let title = "Laundry Delivered to Customer";
    let body = "Your laundry has been delivered to customer";
    let data = {
        bookingId: bookingId,
        driverId: bookingCheck.driverId,
    }
    sendNotification(customerId, title, body, data);

    await tryCreditAgentWallet(bookingId);

    // Prompt customer to leave a shop review (fire-and-forget).
    try {
        const { notifyCustomerRequestReview } = require('../../utils/reviewNotify');
        notifyCustomerRequestReview({
            customerId,
            bookingId,
            orderTrackId: bookingCheck.orderTrackId,
        }).catch((err) =>
            console.warn(
                '[bookingDeliverToCustomer] requestShopReview notify failed:',
                err?.message || err
            )
        );
    } catch (err) {
        console.warn(
            '[bookingDeliverToCustomer] requestShopReview setup failed:',
            err?.message || err
        );
    }

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

    let recurringResult = null;
    try {
        const recurringBookingService = require("../../services/Customer/recurringBookingService");
        recurringResult = await recurringBookingService.generateNextBookingFromCompleted({
            bookingId: Number(bookingId),
            actorUserId: actorId,
            timeZone: req.body?.timeZone || null,
        });
    } catch (err) {
        console.error(
            `[bookingDeliverToCustomer] recurring generation failed for ${bookingId}:`,
            err?.message || err
        );
    }

    return ResponseHelper.success(res, "Laundry Delivered to customer sucessfully", {
        bookingId: Number(bookingId),
        bookingStatusId: 17,
        recurringNextBooking: recurringResult,
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
                attributes: [
                    'id',
                    'name',
                    'zoneAdminComission',
                    'agentCommissionPercent',
                    'zoneMinimumAmount',
                    'serviceCharge',
                ]
            },
            {
                model: tip,
                as: 'tips',
                attributes: ['id', 'amount', 'source', 'paymentType', 'paidAt', 'createdAt'],
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

    const wall = agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone);
    // Invoice finalize → Processing immediately (leave Invoice tab; no separate Proceed required)
    await bookingHistory.bulkCreate([
        { date: wall.date, time: wall.time, bookingId, bookingStatusId: 9 },
        { date: wall.date, time: wall.time, bookingId, bookingStatusId: 10 },
        { date: wall.date, time: wall.time, bookingId, bookingStatusId: 11 },
    ]);

    await booking.update(
        {
            orderAmount: discountedTotal,
            bookingStatusId: 11,
            subTotal,
            invoiceStatus: "finalized",
            invoiceFinalizedAt: new Date(),
        },
        { where: { id: bookingId } }
    );

    // Schedule 2h card auto-charge (no-op for cash / already paid)
    try {
        await invoiceAutoChargeService.scheduleInvoiceAutoCharge(bookingId, {
            finalizedAt: new Date(),
        });
    } catch (scheduleErr) {
        console.error(
            `[invoiceAutoCharge] schedule after AgentAddServices failed booking ${bookingId}:`,
            scheduleErr.message
        );
    }

    const customerId = bookings.customerId;
    sendNotification(
        customerId,
        "Laundry Invoice Generated",
        "Your laundry invoice has been generated and is now being processed",
        {
            bookingId: bookingId,
            driverId: bookings.driverId,
            type: "INVOICE_GENERATED",
        }
    );

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
        bookingStatusId: 11,
    });

    const refreshedBooking = await booking.findByPk(bookingId);
    const paymentGateFlags = invoiceAutoChargeService.buildPaymentGateFlags(
        refreshedBooking,
        paymentSummary?.amountDueNow ?? 0
    );

    return ResponseHelper.success(res, "Agent/Driver Added Detail", {
        bookingId,
        bookingStatusId: 11,
        invoiceStatus: "finalized",
        paymentSummary: {
            ...paymentSummary,
            ...paymentFlags,
            ...paymentGateFlags,
            paymentType: paymentFlags.paymentType,
        },
        servicesSubtotal,
        subTotal,
        total: discountedTotal,
        orderAmount: discountedTotal,
        ...paymentFlags,
        ...paymentGateFlags,
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
                model: users,
                as: "driver",
                required: false,
                attributes: ["id", "firstName", "lastName", "image"],
            },
            {
                model: users,
                as: "deliveryDriver",
                required: false,
                attributes: ["id", "firstName", "lastName", "image"],
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
                    },
                    buildRepairItemsInclude(dbModels),
                ].filter(Boolean),
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
                attributes: ["id", "amount", "source", "paymentType", "paidAt", "createdAt"]
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
    if (!req.isPlatformAdminRequest) {
        const shopAddress = await addressDb.findOne({
            where: {
                userId: shopAgentIdFromReq(req),
                addressType: 'LaundaryShopAddress',
            },
            attributes: ['id'],
        });
        if (
            !shopAddress ||
            Number(bookingData.laundryShopId) !== Number(shopAddress.id)
        ) {
            throw new ForbiddenError('This order does not belong to your shop');
        }
    }
    if (!req.isPlatformAdminRequest && req.isShopEmployee && !req.canAccessInvoice) {
        const actorId = Number(actorUserIdFromReq(req));
        const statusId = Number(bookingData.bookingStatusId || 0);
        const pickupMine = Number(bookingData.driverId) === actorId;
        const deliveryMine = Number(bookingData.deliveryDriverId) === actorId;
        if (deliveryMine && !pickupMine && statusId < 12) {
            throw new ForbiddenError(
                'Delivery starts after the shop completes this order at the facility.'
            );
        }
        if (!pickupMine && !deliveryMine && !actorCanViewShopBoard(req)) {
            throw new ForbiddenError('You can only view orders assigned to you');
        }
    }
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

    bookingData.customerSelectedServices = await hydrateRepairItemsForBooking(
        dbModels,
        bookingId,
        bookingData.customerSelectedServices
    );

    // Frozen customer booking intent — independent of agent invoice lines.
    bookingData.customerDeclaredServices =
        await getCustomerDeclaredServices(bookingId);
    bookingData.repairItems = await getBookingRepairItems(bookingId);

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

    // Physical items (wash qty + unique repair garments). Do not Σ priced
    // repair-option lines — that inflates e.g. 19 garments into "195 items".
    bookingData.totalItems = computePhysicalTotalItems({
        customerSelectedServices: bookingData.customerSelectedServices,
        customerDeclaredServices: bookingData.customerDeclaredServices,
        repairItems: bookingData.repairItems,
    });

    const paymentSummary =
        await invoiceManagementService.getPaymentSummaryForBooking(bookingId);
    bookingData.extraTip = summarizeTips(bookingData.tips || []);

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

    const paymentGateFlags = invoiceAutoChargeService.buildPaymentGateFlags(
        bookingData,
        paymentSummary?.amountDueNow ?? 0
    );

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
    Object.assign(bookingData, paymentGateFlags);

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
        ...paymentGateFlags,
    };

    let responseServicesSubtotal = servicesSubtotal;
    let responsePaymentSummary = paymentSummaryWithFlags;
    if (!req.isPlatformAdminRequest && req.isShopEmployee && !req.canAccessInvoice) {
        hideShopFinanceOnBooking(bookingData, { keepDeclared: true });
        responseServicesSubtotal = 0;
        responsePaymentSummary = slimPaymentSummaryForFieldStaff(
            paymentSummaryWithFlags,
            {
                paymentType: paymentFlags.paymentType,
                canCollectPaymentNow: paymentFlags.canCollectPaymentNow,
                collectPaymentAfterDelivery:
                    paymentFlags.collectPaymentAfterDelivery,
                canProceedWithoutPayment: paymentFlags.canProceedWithoutPayment,
                invoicePaymentWindowApplies:
                    paymentFlags.invoicePaymentWindowApplies,
                amountDueNow:
                    paymentSummaryWithFlags.amountDueNow ??
                    paymentFlags.amountDueNow,
            }
        );
    }

    return ResponseHelper.success(res, "Invoice Details", {
        invoiceDetails: bookingData,
        extraTip: bookingData.extraTip,
        servicesSubtotal: responseServicesSubtotal,
        totalItems: bookingData.totalItems,
        paymentSummary: responsePaymentSummary,
        remainingTime,
        customerHasResponded,
        amountDueNow: paymentSummaryWithFlags.amountDueNow,
        ...paymentFlags,
        ...paymentGateFlags,
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
            price: item.categoryPrice != null ? item.categoryPrice : item.subCategory.price,
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
    const agentId = shopAgentIdFromReq(req);
    const result = await agentDriverManagementService.agnetDrivers(agentId);
    return ResponseHelper.success(
        res,
        "All Drivers Fetched for this Laundry Shop",
        result
    );
}

/*
 * Active reasons for staff unassign / self-return (dropdown).
 */
exports.getStaffUnassignReasons = async (req, res) => {
    const result = await agentDriverManagementService.listStaffUnassignReasons();
    return ResponseHelper.success(res, "Staff unassign reasons", result);
}

/*
 *     Agent Assign Booking To Laundry Driver (pickup; does not force Out for Delivery)
 */
exports.agentAssignBookingToLaundryDriver = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const result = await agentDriverManagementService.agentAssignBookingToLaundryDriver(
        req.body,
        agentId,
        actorUserIdFromReq(req)
    );
    return ResponseHelper.success(res, result.message || "Order assigned to laundry driver", result);
}

/*
 * Assign pickup or delivery staff
 * Body: { bookingId, driverId|staffId, assignmentType?: 'pickup'|'delivery' }
 */
exports.assignBookingStaff = async (req, res) => {
    if (!actorCanManageShopOps(req) && req.canAssignStaff !== true && req.capabilities?.canAssignStaff !== true) {
        throw new ForbiddenError('Only the shop owner or manager can assign staff to jobs');
    }
    const agentId = shopAgentIdFromReq(req);
    const result = await agentDriverManagementService.assignBookingStaff(
        req.body,
        agentId,
        actorUserIdFromReq(req)
    );
    return ResponseHelper.success(res, result.message, result);
}

/*
 * Unassign staff — return job to shop owner.
 * Owner/manager (canAssignStaff): any leg.
 * Driver (canRunAssignedJobs only): only a leg currently assigned to themselves.
 * Body: { bookingId, assignmentType?: 'pickup'|'delivery', reasonId, note? }
 */
exports.unassignBookingStaff = async (req, res) => {
    const canManageAssign =
        req.canAssignStaff === true ||
        req.capabilities?.canAssignStaff === true ||
        actorCanManageShopOps(req);
    const canRun =
        req.canRunAssignedJobs === true ||
        req.capabilities?.canRunAssignedJobs === true;

    if (!canManageAssign && !canRun) {
        throw new ForbiddenError(
            'You do not have permission to return this job to the shop'
        );
    }

    const agentId = shopAgentIdFromReq(req);
    const result = await agentDriverManagementService.unassignBookingStaff(
        req.body,
        agentId,
        actorUserIdFromReq(req),
        { selfOnly: !canManageAssign }
    );
    return ResponseHelper.success(res, result.message, result);
}

/*
 * Reassign staff (same as assign with new staffId)
 */
exports.reassignBookingStaff = async (req, res) => {
    if (!actorCanManageShopOps(req) && req.canAssignStaff !== true && req.capabilities?.canAssignStaff !== true) {
        throw new ForbiddenError('Only the shop owner or manager can reassign staff');
    }
    const agentId = shopAgentIdFromReq(req);
    const result = await agentDriverManagementService.reassignBookingStaff(
        req.body,
        agentId,
        actorUserIdFromReq(req)
    );
    return ResponseHelper.success(res, result.message || "Staff reassigned", result);
}

/*
 * Monitor board — staff jobs for this shop
 * Query: employeeId?, assignmentType?, statusGroup?
 */
exports.getStaffJobs = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    // Drivers may only monitor their own jobs; owner/manager see all
    const query = { ...req.query };
    const canSeeAll =
        req.canAssignStaff === true ||
        req.capabilities?.canAssignStaff === true ||
        req.canViewShopOrders === true ||
        req.capabilities?.canViewShopOrders === true ||
        actorCanViewShopBoard(req);
    if (req.isShopEmployee && !canSeeAll) {
        query.employeeId = actorUserIdFromReq(req);
    }
    const result = await agentDriverManagementService.getStaffJobs(agentId, query);
    return ResponseHelper.success(res, "Staff jobs fetched", result);
}

/*
 * Agent pickup order BySelf
 */
exports.agentPickupOrderBySelf = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const bookingId = req.body?.bookingId ?? req.query?.bookingId;
    // Employees assign themselves as actor; owners use shop agent id
    const selfId = req.isShopEmployee ? actorUserIdFromReq(req) : agentId;
    const result = await agentDriverManagementService.agentPickupOrderBySelf(
        { ...req.body, bookingId, staffId: selfId },
        agentId,
        actorUserIdFromReq(req)
    );
    return ResponseHelper.success(res, result.message || "Agent assigned to pick up order", result);
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
 * Get ClassifiedAs — agent app: Laundry Shop Employee only (not Admin Employee)
 */
exports.getClassifiedAs = async (req, res) => {
    const { getClassifiedAs } = await agentRolePermissionService.getClassifiedAs();
    return ResponseHelper.success(res, "Fetched All ClassifiedAs Roles", getClassifiedAs);
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
    const agentId = shopAgentIdFromReq(req);

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
    const agentId = shopAgentIdFromReq(req);

    let profileImg = null;
    if (req.file) {
        const tempProfileImg = req.file.path;
        profileImg = tempProfileImg.replace(/\\/g, '/');
    }

    await agentEmployeeManagementService.updateEmployee(req.body, profileImg, agentId);
    return ResponseHelper.success(res, "Employee Updated Successfully", {});
}

/*
 * Change Employee status
 */
exports.changeEmployeeStatus = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const result = await agentEmployeeManagementService.changeEmployeeStatus(
        req.body,
        agentId
    );
    return ResponseHelper.success(res, result.message || "Employee Status Updated", {});
}

/*
 * Soft-delete employee belonging to this shop
 */
exports.deleteEmployee = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const employeeId = req.params.employeeId || req.body.employeeId;
    const result = await agentEmployeeManagementService.deleteEmployee(employeeId, agentId);
    return ResponseHelper.success(res, result.message, result);
}

/*
 * Get All Employee
 */
exports.getAllEmployees = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const result = await agentEmployeeManagementService.getAllEmployees(agentId);
    return ResponseHelper.success(res, "All Employee Fetched", result);
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



async function resolveAgentCatalogZoneId(req) {
    const agentId = req.user.id;
    const shop = await addressDb.findOne({
        where: { userId: agentId, addressType: "LaundaryShopAddress" },
        attributes: ["id", "zoneId"],
    });
    const requestedZone = parseInt(req.query.zoneId, 10);
    if (Number.isFinite(requestedZone) && requestedZone > 0) {
        return { shop, zoneId: requestedZone };
    }
    const bookingId = parseInt(req.query.bookingId, 10);
    if (Number.isFinite(bookingId) && bookingId > 0) {
        const row = await booking.findByPk(bookingId, {
            attributes: ["id", "zoneId", "laundryShopId"],
        });
        if (row?.zoneId && (!shop?.id || !row.laundryShopId || Number(row.laundryShopId) === Number(shop.id))) {
            return { shop, zoneId: row.zoneId };
        }
    }
    return { shop, zoneId: shop?.zoneId || null };
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

    const { zoneId: catalogZoneId } = await resolveAgentCatalogZoneId(req);

    const grouped = {};
    for (const sid of serviceIds) {
        const svc = await service.findByPk(sid, {
            attributes: ["id", "name", "image", "status"],
        });
        if (!svc || svc.status === false) continue;
        let tree = await serviceManagementService.getServiceCategoriesDataForService(sid);
        tree = await zoneCatalogService.applyToServiceCategoriesData(
            tree,
            catalogZoneId,
            sid
        );
        if (!tree.length) continue;
        grouped[sid] = {
            serviceId: sid,
            serviceName: svc.name,
            image: svc.image,
            categories: tree.map((row) => ({
                id: row.category.id,
                name: row.category.name,
                status: true,
                image: row.category.image || null,
                description: row.category.description,
                subCategories: (row.category.subCategories || []).map((sc) => {
                    const plain = sc.toJSON ? sc.toJSON() : sc;
                    return {
                        id: plain.id,
                        name: plain.name,
                        status: plain.status,
                        price: plain.price,
                        unitCount: plain.unitCount ?? null,
                        description: plain.description || null,
                    };
                }),
            })),
        };
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
        subCategoryPrice: item.categoryPrice != null ? item.categoryPrice : item.subCategory.price,
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
            const lineAddOns =
                line.addOns && line.addOns.length
                    ? line.addOns
                    : selectedService.addOns || [];
            const { list: addOns, display: addOnsDisplay } = buildAddOnsForTag(lineAddOns);

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
                    subCategoryPrice: selectedService.categoryPrice != null
                        ? selectedService.categoryPrice
                        : subCategory.price,
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
    // Legacy completion-derived score (kept for backward compatibility)
    const completionDerivedRating = Number(((performanceScore / 100) * 5).toFixed(1));

    const shopBiz = await bussinessInformation.findOne({
        where: { shopAddressId: agentShopAddress.id },
        attributes: ['id', 'shopName'],
    });

    let customerRating = {
        avgRating: 0,
        publishedCount: 0,
        ratingCount: 0,
        histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        topPositiveReasonCode: null,
        topNegativeReasonCode: null,
        recentReviews: [],
    };

    if (shopBiz) {
        const shopReviewService = require('../../services/Customer/shopReviewService');
        const reviewData = await shopReviewService.getShopReviews(shopBiz.id, {
            page: 1,
            limit: 10,
        });
        customerRating = {
            ...reviewData.summary,
            recentReviews: reviewData.reviews,
        };
    }

    // Prefer real customer star rating when reviews exist; otherwise fall back
    const rating =
        customerRating.publishedCount > 0
            ? Number(customerRating.avgRating)
            : completionDerivedRating;

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
            rating,
            completionDerivedRating,
            customerRating,
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
    const { amount, note } = req.body || {};
    const data = await agentWithdrawalService.requestWithdrawal(agentId, amount, {
        note,
    });
    const pending = data.status === "pending";
    return ResponseHelper.success(
        res,
        pending
            ? "Withdrawal requested. Waiting for admin approval."
            : "Withdrawal transferred to Stripe Connect successfully",
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

// GET /agent/cash-remittances — the agent's own remittance history (all statuses).
exports.listMyCashRemittances = async (req, res) => {
    const agentId = req.user.id;
    const data = await agentSettlementService.listAgentRemittances(agentId, {
        page: req.query.page,
        limit: req.query.limit,
    });
    return ResponseHelper.success(res, "Cash remittances", data);
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
                attributes: [
                    'id',
                    'name',
                    'zoneAdminComission',
                    'agentCommissionPercent',
                    'zoneMinimumAmount',
                    'serviceCharge',
                ]
            },
            {
                model: tip,
                as: 'tips',
                attributes: ['id', 'amount', 'source', 'paymentType', 'paidAt', 'createdAt'],
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

const { findZones: resolveZonesShared } = require("../../utils/findZones");
const findZones = async (lat, lng) => {
    const rows = await resolveZonesShared(lat, lng);
    if (!rows.length) {
        throw new NotFoundError("No Zone found for these lat,lngs and coordinates");
    }
    return rows;
};

/**
 * Slot bookings for agent home.
 * Uses relevantDate by phase (pickup → collection time/date; status >= 8 → delivery time/date).
 * Optional filterDate (YYYY-MM-DD) scopes slots to that calendar day so Flutter merge
 * cannot resurface facility-done orders on the wrong day.
 */
const getSlotBookings = async (laundryShopId, filterDate, staffScope = null) => {
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

    let dayStart = null;
    let dayEnd = null;
    if (filterDate && moment(filterDate, "YYYY-MM-DD", true).isValid()) {
        dayStart = moment(filterDate, "YYYY-MM-DD").format("YYYY-MM-DD");
        dayEnd = moment(filterDate, "YYYY-MM-DD").add(1, "day").format("YYYY-MM-DD");
    }

    const slotBookings = await Promise.all(
        slots.map(async (slot) => {
            const slotFrom = slot;
            const slotTo = getNextHourTime(slot);
            const baseWhere = agentSlotWhere(laundryShopId, slotFrom, slotTo, dayStart, dayEnd);
            const where = staffScope
                ? { [Op.and]: [baseWhere, staffScope] }
                : baseWhere;

            const bookings = await booking.findAll({
                where,
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
                    "driverId",
                    "deliveryDriverId",
                    "createdAt",
                ],
                include: [
                    {
                        model: bookingStatus,
                        attributes: ['id', 'title', 'description']
                    },
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
                    {
                        model: users,
                        as: "driver",
                        required: false,
                        attributes: ["id", "firstName", "lastName", "image"],
                    },
                    {
                        model: users,
                        as: "deliveryDriver",
                        required: false,
                        attributes: ["id", "firstName", "lastName", "image"],
                    },
                ],
            });

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
                slot: `${slotFrom} - ${slotTo}`,
                bookingCount: enrichedBookings.length,
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
    const { zoneId: catalogZoneId } = await resolveAgentCatalogZoneId(req);
    const rows = await addOnServicesService.getAllAddOnServices({
        activeOnly: true,
        zoneId: catalogZoneId,
        subCategoryId: req.query.subCategoryId,
    });
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

//!---------------------------------------------Shop staff enterprise----------------------------------------//

/**
 * Staff activity board — assignment events + completed jobs
 * Query: from?, to?, employeeId?, type? (pickup|delivery)
 */
exports.getStaffActivity = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const actorId = actorUserIdFromReq(req);
    const query = { ...(req.query || {}) };

    // Drivers may only view their own activity unless they have shop staff-activity rights.
    const canViewAll =
        !req.isShopEmployee ||
        req.capabilities?.canViewStaffActivity === true ||
        req.canViewStaffActivity === true ||
        actorCanViewShopBoard(req);

    if (!canViewAll) {
        // Force self — ignore spoofed employeeId from client.
        query.employeeId = actorId;
        query.includeActive = true;
    }

    const result = await staffActivityService.getStaffActivity(agentId, query);
    return ResponseHelper.success(res, 'Staff activity fetched', result);
};

/**
 * GET auto-assign settings for this shop
 */
exports.getAutoAssignSettings = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const result = await autoAssignService.getSettings(agentId);
    return ResponseHelper.success(res, 'Auto-assign settings fetched', result);
};

/**
 * PUT auto-assign settings
 * Body: { enabled?, strategy?, scope?, fallbackToOwner? }
 */
exports.putAutoAssignSettings = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const result = await autoAssignService.setSettings(agentId, req.body || {});
    return ResponseHelper.success(res, 'Auto-assign settings updated', result);
};

/**
 * PUT employee capability overrides
 * Body: { capabilities: { canAcceptOrders: true, ... } } or flat map of capability keys
 */
exports.putEmployeeCapabilities = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const employeeId = req.params.employeeId;
    const capsMap = req.body?.capabilities || req.body || {};
    const result = await employeeCapabilityService.setForEmployee(
        employeeId,
        agentId,
        capsMap,
        req.user
    );
    return ResponseHelper.success(res, 'Employee capabilities updated', result);
};

/**
 * GET employee capability overrides / effective caps
 */
exports.getEmployeeCapabilities = async (req, res) => {
    const agentId = shopAgentIdFromReq(req);
    const employeeId = req.params.employeeId;
    const result = await employeeCapabilityService.getForEmployee(employeeId, agentId);
    return ResponseHelper.success(res, 'Employee capabilities fetched', result);
};


//!---------------------------------------------Controllers Converted to Export Approach----------------------------------------//


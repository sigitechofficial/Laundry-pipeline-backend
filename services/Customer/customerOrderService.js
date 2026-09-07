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
    bookingAttempt,
    units,
    customerSelectedServiceAddOn,
    addOnServices,
    customerOriginalServiceSnapshot,
    customerOriginalPreferenceSnapshot,
    customerSelectedServiceLine,
    customerSelectedServiceRepairImage,
    customerSelectedRepairItem,
    customerSelectedRepairItemOption,
    customerSelectedRepairItemImage,
    repairGarment,
    repairOption,
} = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('sequelize');
const { getPublicRefundSummary } = require('../Admin/adminRefundService');
const serviceManagementService = require('../Admin/serviceManagementService');
const addOnServicesService = require('../Admin/addOnServicesService');
const repairCatalogService = require('../Admin/repairCatalogService');
const dbModels = require('../../models');
const {
    buildRepairItemsInclude,
    buildBookingLevelRepairItemsInclude,
    hydrateRepairItemsForBooking,
} = require('../../utils/repairBookingInclude');
const {
    replaceServiceLinesForSelectedService,
} = require('../../utils/invoiceLineTotals');
const otpGenerator = require('otp-generator');
const { sendEvent } = require('../../socket_io');
const {
    ValidationError,
    NotFoundError,
    UnauthorizedError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');
const { assertDeliveryMeetsTurnaround } = require('../../utils/turnaroundTime');
const { sumActiveBookingServicesSubtotal, computePhysicalTotalItems } = require('../../utils/invoiceLineTotals');
const {
    getFrozenCustomerDeclaredServices,
    getAgentAddedServicesForCustomer,
    getBookingRepairItems,
} = require('../Agent/customerDeclaredServicesService');
const { buildPaymentSummary, buildPaymentSummaryForBooking, normalizePaymentType, enrichPaymentSummary } = require('../../utils/invoicePaymentSummary');
const { literal, fn, col } = require("sequelize");
const moment = require('moment-timezone');
const {
    BUSINESS_TIME_ZONE,
    BOOKING_ACCEPT_WINDOW_MINUTES,
    PREFERRED_SHOP_WINDOW_MINUTES,
    getOrderExpireTime,
    getAcceptWindowMinutesRemaining,
    formatOrderExpireTimeForApi,
} = require('../../utils/bookingTimeZone');
const {
    isAnyShopOpenInZone,
    isPlatformOpenNow,
    isShopEligibleForBroadcast,
} = require('../../utils/shopWorkingHours');
const { getAcceptWindowAnchor } = require('../../utils/bookingAgentWindow');
const { getAfterHoursOrderExpireTime } = require('../../utils/afterHoursBooking');
const { isShopSlotFree } = require('../../utils/shopSlotAvailability');


// Import stripe functions
const { attachPaymentMethodToCustomer, getIntent, createPaymentIntend, createSetupIntent, createEphemeralKey, paymentIntentGet, createAuthorizationHold } = require('../../controllers/stripe');
const { formatPaymentFailureReason } = require('../../utils/paymentFailureLabels');
const extraTipService = require('./extraTipService');
const { bookingTipAmountFromTips } = require('../../utils/bookingTips');
const { buildStripeChargePresentation } = require('../../utils/stripePaymentMetadata');
const { getPickupChargeAmount } = require('../../utils/invoicePrepaidDeduction');
const {
    findZones,
    findZoneByPostcode,
    zoneInclude,
    zoneAttributes,
} = require('../../utils/findZones');
const zoneCatalogService = require('../Admin/zoneCatalogService');

// Import coupon service
const couponService = require('./couponService');
const cancelBookingService = require('./cancelBookingService');
const noShowEnforcementService = require('../Agent/noShowEnforcementService');
const { resolveNoShowPolicyForBooking } = require('../../utils/safeNoShowPolicyQuery');
const { buildOrderTrackTimeline } = require('../../utils/orderTrackTimeline');
const {
    attachNoShowPolicyOnBooking,
    attachCancellationPolicyOnBooking,
} = require('../../utils/bookingPolicyAttach');

/**
 * Helper Functions (moved from customerOrders controller to avoid circular dependency)
 */


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

// Booking event sent check the shops function
/**
 * Find the preferred shop agent for a customer — the most recent shop that
 * completed an order for them and is still able to take the job.
 *
 * Walks back through earlier completed orders when the latest shop is closed,
 * blocked, no longer offers the services, or has been taken out of preferred
 * routing by an admin. See services/preferredShopResolver.js.
 *
 * Returns the matching addressDb shop row (with .user populated), or null.
 */
async function findPreferredShopForCustomer(customerId, zoneId, services, options = {}) {
    const { resolvePreferredShop } = require('../preferredShopResolver');
    const result = await resolvePreferredShop({
        customerId,
        zoneId,
        services,
        ...options,
    });
    return result.shop;
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
    services,
    timeZone,
    clientTimeZone
) {
    const { getCountryContextFromZoneId } = require("../../utils/countryTimeZone");
    const countryCtx = await getCountryContextFromZoneId(zoneId);
    const resolvedTz = timeZone || countryCtx.ianaTimeZone;

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
                            },
                            status: true,
                        },
                        attributes: ['id', 'serviceId'],
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

    // The customer's distinct selected service IDs. An agent is only eligible
    // for this booking if they actively offer EVERY one of these services.
    const requiredServiceIds = [
        ...new Set(
            (services || [])
                .map((s) => Number(s.serviceId))
                .filter((id) => Number.isFinite(id) && id > 0)
        ),
    ];

    // Shops an admin put on marketplace hold receive no new offers at all.
    const shopAssignmentPolicyService = require('../Admin/shopAssignmentPolicyService');
    const { holdExcluded } =
        await shopAssignmentPolicyService.getRestrictedShopUserIds();

    // Count shops in the zone that actively offer ALL selected services,
    // independent of slot/working-hours availability. Used to detect a service
    // coverage gap (→ notify admin for manual assignment).
    let serviceEligibleShopCount = 0;

    for (let shop of getShopsAndOwners) {
        // Skip shops whose owner does not offer ALL of the selected services.
        const offeredServiceIds = new Set(
            (shop.user?.agentServices || []).map((a) => Number(a.serviceId))
        );
        const offersAllServices =
            requiredServiceIds.length > 0 &&
            requiredServiceIds.every((id) => offeredServiceIds.has(id));
        if (!offersAllServices) {
            continue;
        }

        if (holdExcluded.has(Number(shop.user?.id || shop.userId))) {
            console.log(
                `[broadcast] booking ${bookingId} skipping shop ${shop.id} — marketplace hold`
            );
            continue;
        }

        serviceEligibleShopCount += 1;

        const slotFree = await isShopSlotFree(
            shop.id,
            {
                collectionDate,
                collectionTimeFrom,
                collectionTimeTo,
                deliveryDate,
                deliveryTimeFrom,
                deliveryTimeTo,
            },
            { excludeBookingId: bookingId }
        );
        if (!slotFree) {
            console.log(
                `[broadcast] booking ${bookingId} skipping shop ${shop.id} — slot already taken`
            );
            continue;
        }

        const ownerId = shop.user?.id || shop.userId;
        const shopEligible = await isShopEligibleForBroadcast(
            ownerId,
            countryCtx.countryId,
            resolvedTz,
            clientTimeZone,
            {
                collectionDate,
                collectionTimeFrom,
                collectionTimeTo,
            }
        );
        if (shopEligible) {
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
                        buildRepairItemsInclude(dbModels),
                    ].filter(Boolean),
                },
                buildBookingLevelRepairItemsInclude(dbModels),
                {
                    model: zone,
                    attributes: [
                        "id",
                        "zoneMinimumAmount",
                        "serviceCharge",
                        "currencyUnitId",
                    ],
                },
            ].filter(Boolean),
        });

        console.log("ðŸš€ ~ getBookingDetails ~ bookingDetails:", bookingDetails);

        if (!bookingDetails) {
            return;
        }

        const customerService =
            bookingDetails.customerSelectedServices?.length > 0
                ? bookingDetails.customerSelectedServices
                      .filter((serviceItem) => serviceItem?.service)
                      .map((serviceItem) => ({
                    serviceId: serviceItem.service.id,
                    serviceName: serviceItem.service.name,
                    serviceStatus: serviceItem.service.status,
                    categoryId: serviceItem?.category?.id,
                    categoryName: serviceItem?.category?.name,
                    categoryStatus: serviceItem?.category?.status,
                    subCategoryId: serviceItem?.subCategory?.id,
                    subCategoryName: serviceItem?.subCategory?.name,
                    subCategoryStatus: serviceItem?.subCategory?.status,
                    items: serviceItem.items ?? null,
                    bags: serviceItem.bags ?? null,
                    serviceInstruction: serviceItem.serviceInstruction || null,
                    repairItems: (serviceItem.repairItems || []).map((ri) => {
                        const plain = ri.toJSON ? ri.toJSON() : ri;
                        return {
                            id: plain.id,
                            repairGarmentId: plain.repairGarmentId,
                            garmentName: plain.garmentName,
                            quantity: plain.quantity,
                            instruction: plain.instruction,
                            options: (plain.options || []).map((o) => ({
                                optionName: o.optionName,
                                price: o.price,
                            })),
                            images: (plain.images || []).map((img) => ({
                                imageUrl: img.imageUrl,
                            })),
                        };
                    }),
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
                createdAt: bookingDetails.createdAt,
                orderExpireTime: formatOrderExpireTimeForApi(
                    bookingDetails.orderExpireTime
                ),
                acceptWindowMinutes: getAcceptWindowMinutesRemaining(
                    getAcceptWindowAnchor(bookingDetails),
                    bookingDetails.orderExpireTime,
                    timeZone
                ),
                orderExpireTimeClock: formatOrderExpireTimeForApi(
                    bookingDetails.orderExpireTime
                ),
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
        let notifiedCount = 0;
        const { sendNotification } = require('../../utils/notification');
        const fcmPromises = [];
        availableShops.forEach((shop) => {
            if (shop.user && shop.user.id) {
                sendEvent(shop.user.id, eventData);
                // FCM push — non-blocking, fire-and-forget
                fcmPromises.push(
                    sendNotification(
                        shop.user.id,
                        "New Booking Request",
                        `Order ${bookingDetails.orderTrackId || bookingId} is waiting for acceptance.`,
                        { bookingId: String(bookingId), type: "newBookingRequest" }
                    ).catch((e) =>
                        console.error(`⚠️ FCM failed for agent ${shop.user.id}:`, e.message)
                    )
                );
                notifiedCount += 1;
            } else {
                console.warn(`⚠️ Skipping shop ${shop.id} - no associated user found`);
            }
        });
        // Await all FCM pushes in parallel (non-blocking to booking creation)
        Promise.all(fcmPromises).catch(() => {});
        return {
            notifiedCount,
            availableShopCount: availableShops.length,
            serviceEligibleShopCount,
            zoneShopCount: getShopsAndOwners.length,
        };
    }

    return {
        notifiedCount: 0,
        availableShopCount: 0,
        serviceEligibleShopCount,
        zoneShopCount: getShopsAndOwners.length,
    };
}

/**
 * Phase-1: Notify only the preferred shop agent.
 * Returns true if notification was sent, false otherwise.
 */
async function notifyPreferredShopOnly(bookingId, preferredShop, bookingDetails, collectionDate, collectionTimeTo, collectionTimeFrom, deliveryDate, deliveryTimeTo, deliveryTimeFrom, timeZone, windowMins) {
    try {
        const { sendNotification } = require('../../utils/notification');
        const ownerId = preferredShop.user?.id || preferredShop.userId;
        if (!ownerId) return false;

        const eventData = {
            type: 'newBookingRequest',
            data: {
                id: bookingDetails.id,
                orderTrackId: bookingDetails.orderTrackId,
                collectionDate: new Date(collectionDate).toISOString(),
                collectionTimeTo,
                collectionTimeFrom,
                deliveryDate: new Date(deliveryDate).toISOString(),
                deliveryTimeTo,
                deliveryTimeFrom,
                driverInstructionOptions: bookingDetails.driverInstructionOptions || null,
                driverInstructionOptions1: bookingDetails.driverInstructionOptions1 || null,
                driverInstruction: bookingDetails.driverInstruction || null,
                paymentConfirmed: bookingDetails.paymentConfirmed || false,
                partialPayment: bookingDetails.partialPayment || false,
                totalItems: bookingDetails.totalItems || 0,
                orderAmount: bookingDetails?.billingDetail?.total || 0,
                frequency: bookingDetails.frequency || 'Just Once',
                createdAt: bookingDetails.createdAt,
                orderExpireTime: formatOrderExpireTimeForApi(bookingDetails.orderExpireTime),
                acceptWindowMinutes: getAcceptWindowMinutesRemaining(
                    getAcceptWindowAnchor(bookingDetails),
                    bookingDetails.orderExpireTime,
                    timeZone
                ),
                orderExpireTimeClock: formatOrderExpireTimeForApi(bookingDetails.orderExpireTime),
                laundryShopId: preferredShop.id,
                customerId: bookingDetails.customer?.id,
                pickupAddress: bookingDetails.pickupAddress || {},
                customer: {
                    id: bookingDetails.customer?.id,
                    firstName: bookingDetails.customer?.firstName,
                    lastName: bookingDetails.customer?.lastName,
                    email: bookingDetails.customer?.email,
                    userTypeId: bookingDetails.customer?.userTypeId || 2,
                    image: bookingDetails.customer?.image || null,
                    phoneNum: bookingDetails.customer?.phoneNum,
                },
                zone: bookingDetails.zone || {},
                isPreferredShopOffer: true,
            },
        };

        sendEvent(ownerId, eventData);
        sendNotification(
            ownerId,
            'New Booking Request (Preferred)',
            `A returning customer placed order ${bookingDetails.orderTrackId || bookingId}. You have ${windowMins} minutes to accept.`,
            { bookingId: String(bookingId), type: 'newBookingRequest' }
        ).catch((e) => console.error(`⚠️ FCM failed for preferred agent ${ownerId}:`, e.message));

        console.log(`[preferredShop] booking ${bookingId} → phase-1 notify agent ${ownerId} (shop ${preferredShop.id}), window=${windowMins}m`);
        return true;
    } catch (err) {
        console.error('[notifyPreferredShopOnly] error:', err?.message || err);
        return false;
    }
}

/**
 * Notify admins when no agent in the zone offers all of the customer's selected
 * services, so the booking can be manually assigned. Best-effort / non-blocking.
 */
async function notifyAdminNoEligibleAgent(bookingId, zoneId) {
    try {
        const { sendNotificationToAdmin } = require("../Agent/notificationService");
        const bookingRecord = await booking.findOne({
            where: { id: bookingId },
            attributes: ["id", "orderTrackId"],
        });
        const orderLabel = bookingRecord?.orderTrackId || String(bookingId);
        await sendNotificationToAdmin(
            "Order needs manual assignment",
            `Order #${orderLabel} has no agent in its zone that offers all selected services. Please assign it manually.`,
            {
                bookingId: Number(bookingId),
                zoneId: zoneId != null ? Number(zoneId) : null,
                type: "no_eligible_agent_for_services",
                alertType: "no_eligible_agent",
            }
        );
        console.log(
            `[createBooking] admin notified — no service-eligible agent for booking ${bookingId} (zone ${zoneId})`
        );
    } catch (err) {
        console.error(
            `[createBooking] failed to notify admin for booking ${bookingId}:`,
            err?.message || err
        );
    }
}

function normalizeSelectedServiceAddOn(addOn) {
    const plain = addOn?.toJSON ? addOn.toJSON() : addOn || {};
    const unitPrice =
        parseFloat(plain.price ?? plain.addOnService?.price) || 0;
    const items =
        parseInt(plain.items, 10) > 0 ? parseInt(plain.items, 10) : 1;

    const instructions =
        plain.instructions != null && String(plain.instructions).trim() !== ""
            ? String(plain.instructions).trim()
            : plain.instruction != null && String(plain.instruction).trim() !== ""
              ? String(plain.instruction).trim()
              : null;

    return {
        id: plain.id,
        addOnServiceId: plain.addOnServiceId,
        price: plain.price,
        items,
        instructions,
        lineTotal: parseFloat((unitPrice * items).toFixed(2)),
        addOnService: plain.addOnService || null,
    };
}

function buildSelectedServiceLineKey(serviceItem) {
    return `${serviceItem?.serviceId ?? ""}:${serviceItem?.categoryId ?? ""}:${serviceItem?.subCategoryId ?? ""}`;
}

function extractProofNote(proofs, deliveryType) {
    if (!Array.isArray(proofs)) return null;
    const match = proofs.find(
        (proof) =>
            proof?.deliveryType === deliveryType &&
            proof?.note != null &&
            String(proof.note).trim() !== ""
    );
    return match ? String(match.note).trim() : null;
}

async function hydrateBookingSelectedServiceAddOns(bookingId, selectedServices) {
    if (!Array.isArray(selectedServices) || selectedServices.length === 0) {
        return selectedServices;
    }

    const normalizedBookingId = parseInt(bookingId, 10);
    const activeServiceRows = await customerSelectedService.findAll({
        where: {
            bookingId: normalizedBookingId,
            status: { [Op.in]: [true, 1] },
        },
        attributes: ["id", "serviceId", "categoryId", "subCategoryId"],
        raw: true,
    });

    const lineIdByCompositeKey = {};
    const allServiceLineIds = [];

    for (const row of activeServiceRows) {
        allServiceLineIds.push(row.id);
        lineIdByCompositeKey[buildSelectedServiceLineKey(row)] = row.id;
    }

    const addOnsByServiceId = {};

    if (allServiceLineIds.length > 0) {
        const addOnRows = await customerSelectedServiceAddOn.findAll({
            where: {
                customerSelectedServiceId: { [Op.in]: allServiceLineIds },
            },
            attributes: [
                "id",
                "customerSelectedServiceId",
                "addOnServiceId",
                "price",
                "items",
                "instructions",
            ],
            include: [
                {
                    model: addOnServices,
                    as: "addOnService",
                    attributes: ["id", "name", "price"],
                    required: false,
                },
            ],
            order: [["id", "ASC"]],
        });

        for (const row of addOnRows) {
            const plain = row.toJSON ? row.toJSON() : row;
            const key = Number(plain.customerSelectedServiceId);
            if (!addOnsByServiceId[key]) {
                addOnsByServiceId[key] = [];
            }
            addOnsByServiceId[key].push(normalizeSelectedServiceAddOn(plain));
        }
    }

    return selectedServices.map((serviceItem) => {
        const resolvedLineId =
            serviceItem.id ??
            lineIdByCompositeKey[buildSelectedServiceLineKey(serviceItem)] ??
            null;
        const resolvedLineIdNum =
            resolvedLineId != null ? Number(resolvedLineId) : null;

        const hydratedAddOns =
            resolvedLineIdNum != null
                ? addOnsByServiceId[resolvedLineIdNum]
                : null;
        const addOnsSource =
            hydratedAddOns && hydratedAddOns.length > 0
                ? hydratedAddOns
                : Array.isArray(serviceItem.addOns)
                  ? serviceItem.addOns
                  : [];

        return {
            ...serviceItem,
            ...(resolvedLineIdNum != null ? { id: resolvedLineIdNum } : {}),
            addOns: addOnsSource.map(normalizeSelectedServiceAddOn),
        };
    });
}

function mapCancellationPolicyResponse(cancellationPolicyRaw) {
    if (!cancellationPolicyRaw?.cancellationConfig) return null;
    const config = cancellationPolicyRaw.cancellationConfig;
    return {
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
        // Canonical unprocessed % (of prepaid). Legacy unprocessedPercentage mapped only as fallback display.
        unprocessedChargePercentage:
            (config.unprocessedOrderValuePercentage != null &&
            Number(config.unprocessedOrderValuePercentage) > 0
                ? config.unprocessedOrderValuePercentage
                : config.unprocessedPercentage) ?? null,
        unprocessedAfterPickupMinutes: config.unprocessedAfterPickupMinutes ?? null,
        unprocessedOrderValuePercentage: config.unprocessedOrderValuePercentage ?? null,
        allowCancelUnprocessed: config.allowCancelUnprocessed ?? true,
        courtesyWindowDays: config.courtesyWindowDays ?? null,
        courtesyCount: config.courtesyCount ?? null,
        courtesyCapAmount: config.courtesyCapAmount ?? null,
        customerLeniencyEnabled: config.customerLeniencyEnabled ?? true,
    };
}

function mapNoShowPolicyResponse(noShowPolicyRaw) {
    if (!noShowPolicyRaw?.noShowConfig) return null;
    const config = noShowPolicyRaw.noShowConfig;
    return {
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
        arrivalRadiusMeters: config.arrivalRadiusMeters ?? 100,
        autoForgiveFirstNoShow: config.autoForgiveFirstNoShow ?? true,
        autoForgiveCount: config.autoForgiveCount ?? null,
        autoForgivePeriod: config.autoForgivePeriod ?? null,
        requirePaymentAfterCap: config.requirePaymentAfterCap ?? true,
        perCustomerCap: config.perCustomerCap ?? null,
        capWindowDays: config.capWindowDays ?? null,
        absoluteWaiverAmount: config.absoluteWaiverAmount ?? null,
        percentageWaiverAmount: config.percentageWaiverAmount ?? null,
    };
}

function resolveCancellationPhase(bookingStatusId) {
    const statusId = Number(bookingStatusId);

    if (statusId === 19) {
        return {
            phase: 'cancelled',
            label: 'Cancelled',
            canCancel: false,
            cancelBlockedReason: 'This booking has already been cancelled',
        };
    }
    if ([16, 17].includes(statusId)) {
        return {
            phase: 'completed',
            label: 'Completed',
            canCancel: false,
            cancelBlockedReason: 'Cannot cancel completed bookings',
        };
    }
    if (statusId === 11) {
        return {
            phase: 'processing',
            label: 'Processing at facility',
            canCancel: false,
            cancelBlockedReason:
                'Cannot cancel booking. Items are currently being processed at the facility',
        };
    }
    if (statusId === 10) {
        return {
            phase: 'invoiced',
            label: 'Invoice generated',
            canCancel: false,
            cancelBlockedReason: 'Cannot cancel booking. Invoice has already been generated',
        };
    }
    if (statusId >= 12) {
        return {
            phase: 'post_invoice',
            label: 'Post-invoice / delivery stage',
            canCancel: false,
            cancelBlockedReason: 'Cannot cancel booking at this stage',
        };
    }
    if ([1, 2, 3].includes(statusId)) {
        return {
            phase: 'pre_pickup',
            label: 'Pre-pickup',
            canCancel: true,
            cancelBlockedReason: null,
        };
    }
    if ([4, 5, 6, 7, 8, 9].includes(statusId)) {
        return {
            phase: 'unprocessed',
            label: 'Unprocessed (picked up, before invoice)',
            canCancel: true,
            cancelBlockedReason: null,
        };
    }

    return {
        phase: 'unknown',
        label: 'Unknown',
        canCancel: false,
        cancelBlockedReason: 'Cannot cancel booking at this stage',
    };
}

function mapCustomerAttemptRow(attemptRow) {
    if (!attemptRow) return null;
    return {
        id: attemptRow.id,
        attemptType: attemptRow.attemptType,
        attemptNumber: attemptRow.attemptNumber,
        status: attemptRow.status,
        feeAmount: parseFloat(attemptRow.feeAmount) || 0,
        feeCurrency: attemptRow.feeCurrency || null,
        feeWaived: Boolean(attemptRow.feeWaived),
        feeWaiveReason: attemptRow.feeWaiveReason || null,
        unattendedMethod: attemptRow.unattendedMethod || null,
        failureReason: attemptRow.failureReason || null,
        driverLateMinutes: attemptRow.driverLateMinutes ?? null,
        arrivedAt: attemptRow.arrivedAt || null,
        completedAt: attemptRow.completedAt || null,
        failedAt: attemptRow.failedAt || null,
    };
}

async function buildCustomerBookingPolicySummaries(bookingPlain, { timeZone } = {}) {
    let cancellationPolicyRaw = bookingPlain.cancellationPolicyBookings;
    if (!cancellationPolicyRaw?.cancellationConfig) {
        cancellationPolicyRaw = await cancelBookingService.resolveCancellationPolicy(
            bookingPlain
        );
    }

    let noShowPolicyRaw = bookingPlain.noShowPolicyBookings;
    if (!noShowPolicyRaw?.noShowConfig) {
        noShowPolicyRaw = await resolveNoShowPolicyForBooking({
            noShowPolicyId: bookingPlain.noShowPolicyId,
            zoneId: bookingPlain.zoneId,
        });
    }

    const cancellationPolicy = mapCancellationPolicyResponse(cancellationPolicyRaw);
    const noShowPolicy = mapNoShowPolicyResponse(noShowPolicyRaw);
    const phase = resolveCancellationPhase(bookingPlain.bookingStatusId);

    let feePreview = null;
    if (phase.canCancel) {
        const config = cancellationPolicyRaw?.cancellationConfig;
        if (
            phase.phase === 'unprocessed' &&
            config &&
            config.allowCancelUnprocessed === false
        ) {
            phase.canCancel = false;
            phase.cancelBlockedReason =
                'Cancellation is not allowed at this stage according to the policy';
        } else {
            const feeBaseAmount =
                cancelBookingService.resolvePrepaidChargedAmount(bookingPlain);
            const prepaidCharged = bookingPlain.paymentConfirmed ? feeBaseAmount : 0;
            feePreview = await cancelBookingService.calculateCancellationCharge(
                bookingPlain,
                cancellationPolicyRaw,
                bookingPlain.customerId,
                timeZone || null,
                prepaidCharged,
                feeBaseAmount
            );
        }
    }

    const pickupFeePreview = noShowPolicyRaw
        ? await noShowEnforcementService.calculateNoShowFee({
              bookingData: bookingPlain,
              attemptType: 'pickup',
              driverLateMinutes: 0,
              policyRecord: noShowPolicyRaw,
          })
        : null;

    const deliveryFeePreview = noShowPolicyRaw
        ? await noShowEnforcementService.calculateNoShowFee({
              bookingData: bookingPlain,
              attemptType: 'delivery',
              driverLateMinutes: 0,
              policyRecord: noShowPolicyRaw,
          })
        : null;

    const attemptRows = Array.isArray(bookingPlain.attempts) ? bookingPlain.attempts : [];
    const maxPickupAttempts = bookingPlain.maxPickupAttempts ?? 3;
    const pickupAttemptCount = bookingPlain.pickupAttemptCount ?? 0;
    const deliveryAttemptCount = bookingPlain.deliveryAttemptCount ?? 0;

    const cancellationSummary = {
        phase: phase.phase,
        phaseLabel: phase.label,
        canCancel: phase.canCancel,
        cancelBlockedReason: phase.cancelBlockedReason,
        policy: cancellationPolicy,
        policySource: bookingPlain.cancellationPolicyId ? 'snapshotted' : 'active',
        feePreview,
    };

    const noShowSummary = {
        policy: noShowPolicy,
        policySource: bookingPlain.noShowPolicyId ? 'snapshotted' : 'active',
        pickupAttemptCount,
        deliveryAttemptCount,
        maxPickupAttempts,
        remainingPickupAttempts: Math.max(0, maxPickupAttempts - pickupAttemptCount),
        noShowFeeAccrued: parseFloat(bookingPlain.noShowFeeAccrued) || 0,
        feePreview: {
            pickup: pickupFeePreview,
            delivery: deliveryFeePreview,
        },
        attempts: attemptRows.map(mapCustomerAttemptRow).filter(Boolean),
    };

    return {
        cancellationPolicy,
        noShowPolicy,
        cancellationSummary,
        noShowSummary,
        orderStatusContext: {
            bookingStatusId: bookingPlain.bookingStatusId,
            title: bookingPlain.bookingStatus?.title || null,
            description: bookingPlain.bookingStatus?.description || null,
            cancellationPhase: phase.phase,
            cancellationPhaseLabel: phase.label,
        },
    };
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

    /**
     * Dedicated repair/alteration catalog (garments + repair options).
     * Not wash categories / subcategories / add-ons.
     */
    async getRepairCatalog(serviceId, data = {}) {
        let zoneId = data.zoneId ? Number(data.zoneId) : null;
        if (!zoneId && data.lat != null && data.lng != null) {
            const matched = await findZones(Number(data.lat), Number(data.lng));
            zoneId = matched?.[0]?.id || null;
        }
        return repairCatalogService.getCatalogForCustomer(serviceId, { zoneId });
    }

    /**
     * Persist customer repair selections on dedicated repair booking tables.
     * Keeps the single CSS placeholder row for the repairing service.
     */
    async _persistRepairItemsForBooking({
        bookingId,
        serviceCreate,
        repairItems,
        selectedServiceIds,
    }) {
        const linesByService = new Map();
        for (const raw of repairItems) {
            const sid = Number(raw.serviceId);
            if (!sid) continue;
            linesByService.set(sid, (linesByService.get(sid) || 0) + 1);
        }
        const qtyByService = new Map();

        for (const raw of repairItems) {
            const serviceId = Number(raw.serviceId);
            const repairGarmentId = Number(raw.repairGarmentId);
            const repairOptionIds = Array.isArray(raw.repairOptionIds)
                ? [...new Set(raw.repairOptionIds.map((id) => Number(id)).filter(Boolean))]
                : [];
            const imageUrls = Array.isArray(raw.imageUrls)
                ? raw.imageUrls
                      .map((u) => String(u || '').trim())
                      .filter(Boolean)
                      .slice(0, 5)
                : [];
            const instruction =
                raw.instruction != null ? String(raw.instruction).trim() : '';
            let quantity = Math.max(1, Number(raw.quantity) || 1);

            if (!serviceId || !selectedServiceIds.includes(serviceId)) {
                throw new ValidationError(
                    `repairItems serviceId ${raw.serviceId} is not part of selected services`
                );
            }
            if (!repairGarmentId) {
                throw new ValidationError('Each repair item requires repairGarmentId');
            }
            if (repairOptionIds.length === 0) {
                throw new ValidationError(
                    'Each repair item requires at least one repairOptionId'
                );
            }

            const garment = await repairGarment.findOne({
                where: { id: repairGarmentId, status: true },
                include: [
                    {
                        model: repairOption,
                        as: 'options',
                        attributes: ['id', 'name', 'price', 'status'],
                        through: { attributes: [] },
                    },
                ],
            });
            if (!garment) {
                throw new ValidationError(
                    `Repair garment ${repairGarmentId} was not found`
                );
            }

            const allowed = new Map(
                (garment.options || [])
                    .filter((o) => o.status !== false)
                    .map((o) => [Number(o.id), o])
            );
            for (const optionId of repairOptionIds) {
                if (!allowed.has(optionId)) {
                    throw new ValidationError(
                        `Repair option ${optionId} is not available for garment ${garment.name}`
                    );
                }
            }

            const cssRow =
                serviceCreate.find((s) => Number(s.serviceId) === serviceId) || null;

            // One garment + card item count (e.g. 6 shirts, same hem) must
            // land on the repair row, not stay as a CSS-only items=6.
            if ((linesByService.get(serviceId) || 0) === 1) {
                const cssItems = Number(cssRow?.items) || 0;
                if (cssItems > quantity) quantity = cssItems;
            }

            const itemRow = await customerSelectedRepairItem.create({
                bookingId,
                customerSelectedServiceId: cssRow?.id || null,
                serviceId,
                repairGarmentId,
                garmentName: garment.name,
                quantity,
                instruction: instruction || null,
            });
            qtyByService.set(
                serviceId,
                (qtyByService.get(serviceId) || 0) + quantity
            );

            let repairZoneId = null;
            try {
                const bookingRow = await booking.findByPk(bookingId, {
                    attributes: ["id", "zoneId"],
                });
                repairZoneId = bookingRow?.zoneId || null;
            } catch (_) {
                repairZoneId = null;
            }

            const optionRows = [];
            for (const optionId of repairOptionIds) {
                const opt = allowed.get(optionId);
                let price = Number(opt.price) || 0;
                try {
                    const resolved = await zoneCatalogService.resolvePrice(repairZoneId, {
                        repairOptionId: optionId,
                    });
                    price = resolved.price;
                } catch (_) {
                    /* master price */
                }
                optionRows.push({
                    customerSelectedRepairItemId: itemRow.id,
                    repairOptionId: optionId,
                    optionName: opt.name,
                    price,
                });
            }
            await customerSelectedRepairItemOption.bulkCreate(optionRows);

            if (imageUrls.length > 0) {
                await customerSelectedRepairItemImage.bulkCreate(
                    imageUrls.map((imageUrl, index) => ({
                        customerSelectedRepairItemId: itemRow.id,
                        imageUrl,
                        sortOrder: index + 1,
                    }))
                );
            }
        }

        for (const css of serviceCreate) {
            const sid = Number(css.serviceId);
            const sum = qtyByService.get(sid);
            if (!sum) continue;
            if (Number(css.items) !== sum) {
                await css.update({ items: sum });
            }
        }

        return serviceCreate;
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
     * For card bookings an authorization hold (manual-capture PaymentIntent) is
     * created at booking for upfront + service fee + tip. Capture happens at Status 4.
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
            clientTimeZone,
            couponCode,
            paymentType: rawPaymentType,
            repairItems,
        } = data;

        const paymentType = normalizePaymentType(rawPaymentType);

        console.log("stripeCustomerId==============>>>", stripeCustomerId);
        console.log("paymentType==============>>>", paymentType);
        console.log("🚀 ~ createBooking ~ req.body:", data);

        if (paymentType === "card" && !paymentMethodId) {
            throw new ValidationError(
                "Payment method is required for card bookings"
            );
        }

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
        // paymentIntentId is set at booking for card (auth hold); captured at Status 4.
        const { getCountryContextFromZoneId: resolveCountryFromZone } = require("../../utils/countryTimeZone");
        const bookingCountryCtx = await resolveCountryFromZone(zoneId);
        const operationalTimeZone =
            timeZone || bookingCountryCtx.ianaTimeZone || BUSINESS_TIME_ZONE;
        const customerLocalTimeZone = clientTimeZone || null;

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
            setupIntentId: paymentType === "card" ? setupIntentId : null,
            paymentMethodId: paymentType === "card" ? paymentMethodId : null,
            paymentType,
            operationalTimeZone,
            customerLocalTimeZone,
        });

        // Prime recurring plan link early for non-"Just Once" bookings so
        // delivery completion can generate the next cycle idempotently.
        try {
            const recurringBookingService = require('./recurringBookingService');
            await recurringBookingService.ensurePlanForBooking(bookingData.id);
        } catch (err) {
            console.warn(
                `[createBooking] recurring plan bootstrap skipped for booking ${bookingData.id}:`,
                err?.message || err
            );
        }

        try {
            await Promise.all([
                attachNoShowPolicyOnBooking(bookingData.id, zoneId),
                attachCancellationPolicyOnBooking(bookingData.id, zoneId),
            ]);
        } catch (policyAttachErr) {
            console.warn(
                `[createBooking] policy snapshot attach failed for booking ${bookingData.id}:`,
                policyAttachErr?.message || policyAttachErr
            );
        }

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
            const serviceData = [];
            for (const service of services) {
                let unitPrice = null;
                await zoneCatalogService.assertLineEnabled(zoneId, {
                    serviceId: service.serviceId,
                    categoryId: service.categoryId,
                    subCategoryId: service.subCategoryId,
                });
                if (service.subCategoryId) {
                    const resolved = await zoneCatalogService.resolvePrice(zoneId, {
                        subCategoryId: service.subCategoryId,
                    });
                    unitPrice = resolved.price;
                }

                const serviceObj = {
                    bookingId: bookingData.id,
                    serviceId: service.serviceId,
                    date: currentDate,
                    time: currentTime,
                    status: true,
                };
                if (service.categoryId) serviceObj.categoryId = service.categoryId;
                if (service.subCategoryId) serviceObj.subCategoryId = service.subCategoryId;
                if (Number.isFinite(unitPrice) && unitPrice >= 0) {
                    serviceObj.categoryPrice = unitPrice;
                }
                if (service.serviceInstruction) serviceObj.serviceInstruction = service.serviceInstruction;
                if (service.items != null && service.items !== '') {
                    serviceObj.items = Number(service.items);
                }
                const bagVal = service.bags ?? service.bagsCount;
                if (bagVal != null && bagVal !== '') {
                    const n = Number(bagVal);
                    if (Number.isFinite(n) && n > 0) serviceObj.bags = Math.floor(n);
                }

                serviceData.push(serviceObj);
            }
            categoryCharge = serviceData.reduce((acc, row) => {
                const qty = Number(row.items) > 0 ? Number(row.items) : 1;
                return acc + parseFloat(row.categoryPrice || 0) * qty;
            }, 0);
            total = parseFloat(categoryCharge.toFixed(2));
            console.log("🚀 ~ createBooking ~ serviceData:", serviceData);
            serviceCreate = await customerSelectedService.bulkCreate(serviceData);
            console.log("🚀 ~ createBooking ~ serviceCreate:", serviceCreate);

            // Expand repairing service into per-garment rows + add-ons + images.
            if (Array.isArray(repairItems) && repairItems.length > 0) {
                serviceCreate = await this._persistRepairItemsForBooking({
                    bookingId: bookingData.id,
                    serviceCreate,
                    repairItems,
                    currentDate,
                    currentTime,
                    selectedServiceIds: (services || []).map((s) => Number(s.serviceId)),
                });
            }

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

            // ── Snapshot customer's original selections immediately at booking creation ──
            try {
                const snapServices = await customerSelectedService.findAll({
                    where: { bookingId: bookingData.id, status: true }
                });
                for (const svc of snapServices) {
                    const snap = await customerOriginalServiceSnapshot.create({
                        bookingId:          bookingData.id,
                        serviceId:          svc.serviceId          ?? null,
                        categoryId:         svc.categoryId         ?? null,
                        subCategoryId:      svc.subCategoryId      ?? null,
                        items:              svc.items               ?? null,
                        bags:               svc.bags                ?? null,
                        categoryPrice:      svc.categoryPrice       ?? null,
                        serviceInstruction: svc.serviceInstruction  ?? null,
                    });
                    const svcPrefs = await bookingPreference.findAll({
                        where: { bookingId: bookingData.id, customerSelectedServiceId: svc.id }
                    });
                    if (svcPrefs.length > 0) {
                        await customerOriginalPreferenceSnapshot.bulkCreate(
                            svcPrefs.map((p) => ({
                                bookingId:               bookingData.id,
                                snapshotServiceId:       snap.id,
                                preferenceTypeId:        p.preferenceTypeId        ?? null,
                                preferenceValueId:       p.preferenceValueId       ?? null,
                                parentPreferenceValueId: p.parentPreferenceValueId ?? null,
                                preferenceInstruction:   p.preferenceInstruction   ?? null,
                            }))
                        );
                    }
                }
                const bookingLevelPrefs = await bookingPreference.findAll({
                    where: { bookingId: bookingData.id, customerSelectedServiceId: null }
                });
                if (bookingLevelPrefs.length > 0) {
                    await customerOriginalPreferenceSnapshot.bulkCreate(
                        bookingLevelPrefs.map((p) => ({
                            bookingId:               bookingData.id,
                            snapshotServiceId:       null,
                            preferenceTypeId:        p.preferenceTypeId        ?? null,
                            preferenceValueId:       p.preferenceValueId       ?? null,
                            parentPreferenceValueId: p.parentPreferenceValueId ?? null,
                            preferenceInstruction:   p.preferenceInstruction   ?? null,
                        }))
                    );
                }
            } catch (snapErr) {
                console.error(`⚠️ Failed to snapshot customer selections for booking ${bookingData.id}:`, snapErr.message);
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
                orderExpireTime: null,
                partialPayment: paymentType !== "cash",
                subTotal: discountedTotal,
                tipId: tipCreate.id,
            },
            { where: { id: bookingData.id } }
        );

        if (paymentType === "card" && paymentMethodId && stripeCustomerId) {
            await attachPaymentMethodToCustomer(stripeCustomerId, paymentMethodId);

            const holdAmount = getPickupChargeAmount(
                parsedUpfront,
                parsedServiceCharge,
                parsedTip
            );
            if (holdAmount <= 0) {
                throw new ValidationError(
                    "Cannot create authorization hold — prepaid amount is zero"
                );
            }

            const customerRow = await users.findOne({
                where: { id: userId },
                attributes: ["id", "firstName", "lastName", "email"],
            });

            const stripePresentation = buildStripeChargePresentation({
                chargeType: "booking_auth_hold",
                bookingId: bookingData.id,
                orderTrackId: ordertrackingNumber,
                amount: holdAmount,
                currency: "GBP",
                paymentType: "card",
                customer: customerRow || { id: userId },
                agent: {},
                billing: {
                    upfrontAmount: parsedUpfront,
                    serviceFee: parsedServiceCharge,
                    driverTip: parsedTip,
                },
                zoneId,
            });

            try {
                const authHold = await createAuthorizationHold(
                    holdAmount,
                    stripeCustomerId,
                    paymentMethodId,
                    `booking-${bookingData.id}-auth-hold`,
                    stripePresentation
                );

                await booking.update(
                    {
                        paymentIntentId: authHold.id,
                        pickupPaymentIntentId: authHold.id,
                        // Captured later at On the Way — hold is not a capture
                        paymentConfirmed: false,
                    },
                    { where: { id: bookingData.id } }
                );

                console.log(
                    `✅ Auth hold ${authHold.id} placed for booking ${bookingData.id} amount=${holdAmount}`
                );
            } catch (holdErr) {
                console.error(
                    `❌ Auth hold failed for booking ${bookingData.id}:`,
                    holdErr.message
                );
                await booking.update(
                    { bookingStatusId: 19 },
                    { where: { id: bookingData.id } }
                );
                throw new ValidationError(
                    `Card authorization failed: ${holdErr.message || "unable to place hold"}`
                );
            }
        } else if (paymentType === "card") {
            throw new ValidationError(
                "Stripe customer ID is required for card bookings"
            );
        }

        let bookingId = bookingData.id;
        const { getCountryContextFromZoneId } = require("../../utils/countryTimeZone");
        const countryCtx = await getCountryContextFromZoneId(zoneId);
        const resolvedTz = timeZone || countryCtx.ianaTimeZone || BUSINESS_TIME_ZONE;
        const platformOpenNow = await isPlatformOpenNow(
            countryCtx.countryId,
            resolvedTz
        );
        const zoneOpenNow =
            platformOpenNow &&
            (await isAnyShopOpenInZone(zoneId, resolvedTz));
        let agentBroadcastHeld = false;

        if (!platformOpenNow) {
            const afterHoursExpiry = await getAfterHoursOrderExpireTime(
                countryCtx.countryId,
                resolvedTz,
                null,
                new Date()
            );
            agentBroadcastHeld = true;
            await booking.update(
                {
                    agentBroadcastHeld: true,
                    agentVisibleAt: null,
                    orderExpireTime: afterHoursExpiry.orderExpireTime,
                    placedOutsidePlatformHours: true,
                },
                { where: { id: bookingId } }
            );
            console.log(
                `[createBooking] booking ${bookingId} held (after-hours) — expires ${afterHoursExpiry.platformOpenDay} ${afterHoursExpiry.orderExpireTime} tz=${resolvedTz}`
            );
            const { releaseHeldBookingsForZone } = require("../bookingHeldReleaseService");
            await releaseHeldBookingsForZone(zoneId);
        } else if (!zoneOpenNow) {
            agentBroadcastHeld = true;
            await booking.update(
                {
                    agentBroadcastHeld: true,
                    agentVisibleAt: null,
                    orderExpireTime: null,
                },
                { where: { id: bookingId } }
            );
            console.log(
                `[createBooking] booking ${bookingId} held — no shop open in zone ${zoneId} (tz=${resolvedTz})`
            );
        } else {
            const visibleAt = new Date();
            const expireTime = getOrderExpireTime(resolvedTz);

            // --- Preferred-shop Phase-1 check ---
            // If this customer has a previous completed order, give that shop a
            // PREFERRED_SHOP_WINDOW_MINUTES head-start before broadcasting to all.
            const runtimeSettings = require('../Admin/runtimeSettingsService');
            const { resolvePreferredShop, SKIP_REASONS } = require('../preferredShopResolver');
            const preferredEnabled = await runtimeSettings.getBoolean('preferredShopEnabled');
            const preferredWindowMins = preferredEnabled
                ? await runtimeSettings.getInteger('preferredShopWindowMinutes')
                : 0;
            const preferredResult = preferredEnabled
                ? await resolvePreferredShop({
                      customerId: userId,
                      zoneId,
                      services,
                      collectionDate: normalizedCollectionDate,
                      collectionTimeFrom: normalizedCollectionTimeFrom,
                      collectionTimeTo: normalizedCollectionTimeTo,
                      deliveryDate: normalizedDeliveryDate,
                      deliveryTimeFrom: normalizedDeliveryTimeFrom,
                      deliveryTimeTo: normalizedDeliveryTimeTo,
                      timeZone: resolvedTz,
                      clientTimeZone,
                  })
                : { shop: null, skipReason: SKIP_REASONS.DISABLED };
            const preferredShop = preferredResult.shop;

            if (preferredShop) {
                const preferredShopExpiresAt = new Date(Date.now() + preferredWindowMins * 60 * 1000);
                await booking.update(
                    {
                        agentBroadcastHeld: false,
                        agentVisibleAt: visibleAt,
                        orderExpireTime: expireTime,
                        placedOutsidePlatformHours: false,
                        preferredShopAgentId: preferredShop.user.id,
                        preferredShopExpiresAt,
                        preferredShopBroadcastDone: false,
                        preferredShopSkipReason: null,
                    },
                    { where: { id: bookingId } }
                );
                    console.log(
                        `[createBooking] booking ${bookingId} → preferred-shop phase-1 agent=${preferredShop.user.id} shop=${preferredShop.id} expiresAt=${preferredShopExpiresAt.toISOString()} window=${preferredWindowMins}m candidates=${preferredResult.candidateShopIds?.length ?? 0}`
                    );

                // Fetch booking details to build the notification payload
                const bookingDetailsForNotify = await booking.findOne({
                    where: { id: bookingId },
                    include: [
                        { model: users, as: 'customer', attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'userTypeId', 'image'] },
                        { model: addressDb, as: 'pickupAddress', attributes: ['id', 'streetAddress', 'district', 'province', 'postalcode', 'lat', 'lng', 'addressType'] },
                        { model: billingDetails, as: 'billingDetail', attributes: ['total', 'serviceCharge', 'categoryCharge'] },
                        { model: zone, attributes: ['id', 'zoneMinimumAmount', 'serviceCharge', 'currencyUnitId'] },
                    ].filter(Boolean),
                });

                if (bookingDetailsForNotify) {
                    const sent = await notifyPreferredShopOnly(
                        bookingId, preferredShop, bookingDetailsForNotify,
                        collectionDate, collectionTimeTo, collectionTimeFrom,
                        deliveryDate, deliveryTimeTo, deliveryTimeFrom,
                        resolvedTz, preferredWindowMins
                    );
                    if (!sent) {
                        // Preferred shop notify failed — fall back to full broadcast
                        await booking.update(
                            { preferredShopAgentId: null, preferredShopExpiresAt: null, preferredShopBroadcastDone: true },
                            { where: { id: bookingId } }
                        );
                        await bookingEventSentCheckTheShops(
                            bookingId, zoneId, collectionDate, collectionTimeTo, collectionTimeFrom,
                            deliveryDate, deliveryTimeTo, deliveryTimeFrom, services, resolvedTz
                        );
                    }
                }
            } else {
                // No preferred shop — broadcast to all as normal
                await booking.update(
                    {
                        agentBroadcastHeld: false,
                        agentVisibleAt: visibleAt,
                        orderExpireTime: expireTime,
                        placedOutsidePlatformHours: false,
                        preferredShopBroadcastDone: true,
                        preferredShopSkipReason: preferredResult.skipReason || null,
                    },
                    { where: { id: bookingId } }
                );
                console.log(
                    `[createBooking] booking ${bookingId} → broadcast (preferred skipped: ${preferredResult.skipReason || 'none'}) acceptWindowMinutes=${BOOKING_ACCEPT_WINDOW_MINUTES} orderExpireTimeClock=${expireTime} tz=${resolvedTz}`
                );

                const {
                    notifiedCount,
                    serviceEligibleShopCount,
                    zoneShopCount,
                } = await bookingEventSentCheckTheShops(
                    bookingId,
                    zoneId,
                    collectionDate,
                    collectionTimeTo,
                    collectionTimeFrom,
                    deliveryDate,
                    deliveryTimeTo,
                    deliveryTimeFrom,
                    services,
                    resolvedTz
                );

                if (notifiedCount === 0) {
                    agentBroadcastHeld = true;
                    await booking.update(
                        {
                            agentBroadcastHeld: true,
                            agentVisibleAt: null,
                            orderExpireTime: null,
                        },
                        { where: { id: bookingId } }
                    );
                    console.log(
                        `[createBooking] booking ${bookingId} held — zone open but no agent notified`
                    );
                }

                // Service coverage gap: shops exist in the zone but none offer ALL of
                // the customer's selected services → notify admin for manual assignment.
                if (zoneShopCount > 0 && serviceEligibleShopCount === 0) {
                    await notifyAdminNoEligibleAgent(bookingId, zoneId);
                }
            }
        }

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
            message: agentBroadcastHeld
                ? "Booking Created. Agents will be notified when shops open."
                : "Booking Created",
            agentBroadcastHeld,
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
            attributes: ["id", "orderAmount", "orderTrackId", "bookingStatusId", "collectionDate", "collectionTimeFrom", "collectionTimeTo", "deliveryDate", "deliveryTimeFrom", "deliveryTimeTo", "driverInstructionOptions", "driverInstructionOptions1", "pickupAttemptCount", "pickupRescheduleRequired", "deliveryAttemptCount", "noShowFeeAccrued"],
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
        const { bookingId, orderTrackId, timeZone } = data;

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
                        "id",
                        "date",
                        "time",
                        "categoryprice",
                        "categoryId",
                        "serviceId",
                        "subCategoryId",
                        "items",
                        "bags",
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
                            attributes: ['id', 'addOnServiceId', 'price', 'items', 'instructions'],
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
                        buildRepairItemsInclude(dbModels),
                    ].filter(Boolean),
                },
                buildBookingLevelRepairItemsInclude(dbModels),
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
                    attributes: ["id", "date", "time", "createdAt"],
                    separate: true,
                    order: [
                        ["date", "DESC"],
                        ["time", "DESC"],
                        ["id", "DESC"],
                    ],
                    include: [
                        {
                            model: bookingStatus,
                            attributes: ["id", "title", "description"],
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
                    attributes: ["id", "imgUpload", "noOfItems", "noOfBags", "note", "deliveryType", "createdAt", "updatedAt"],
                },
                {
                    model: tip,
                    as: 'tips',
                    attributes: ["id", "amount", "source", "paymentType", "paidAt", "createdAt"],
                    required: false,
                },
                {
                    model: billingDetails,
                    as: 'billingDetail',
                    attributes: ["id", "upfrontAmount", "discount", "total", "zoneAdminCommission", "serviceCharge", "categoryCharge", "pickupDriverEarning", "deliveryDriverEarning", "paymentStatus"],
                    required: false,
                },
                {
                    model: bookingAttempt,
                    as: 'attempts',
                    required: false,
                    attributes: [
                        'id',
                        'attemptType',
                        'attemptNumber',
                        'status',
                        'arrivedAt',
                        'completedAt',
                        'failedAt',
                        'feeAmount',
                        'feeCurrency',
                        'feeWaived',
                        'feeWaiveReason',
                        'unattendedMethod',
                        'failureReason',
                        'driverLateMinutes',
                    ],
                    order: [['id', 'DESC']],
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
                                "arrivalRadiusMeters",
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
            ].filter(Boolean),
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

        bookingPlain.customerSelectedServices =
            await hydrateBookingSelectedServiceAddOns(
                bookingPlain.id,
                selectedServices
            );

        bookingPlain.customerSelectedServices =
            await hydrateRepairItemsForBooking(
                dbModels,
                bookingPlain.id,
                bookingPlain.customerSelectedServices
            );

        const policySummaries = await buildCustomerBookingPolicySummaries(bookingPlain, {
            timeZone,
        });

        const {
            cancellationPolicy,
            noShowPolicy,
            cancellationSummary,
            noShowSummary,
            orderStatusContext,
        } = policySummaries;

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

        const servicesSubtotal = await sumActiveBookingServicesSubtotal(
            bookingPlain.id
        );

        const billing = bookingPlain.billingDetail || {};
        const tipAmount = bookingTipAmountFromTips(bookingPlain.tips);
        const extraTip = extraTipService.buildExtraTipPayload(bookingPlain, {
            canAdd: extraTipService.isCompletedStatus(bookingPlain.bookingStatusId),
        });
        const serviceFee =
            parseFloat(billing.serviceCharge) ||
            parseFloat(bookingPlain.zone?.serviceCharge) ||
            0;
        const minimumOrderPayment =
            parseFloat(billing.upfrontAmount) ||
            parseFloat(bookingPlain.zone?.zoneMinimumAmount) ||
            0;
        const currencySymbol =
            bookingPlain.zone?.currencyUnitZ?.symbol || "£";
        const currency =
            bookingPlain.zone?.currencyUnitZ?.name || "GBP";

        const paymentSummary = enrichPaymentSummary(
            buildPaymentSummaryForBooking(bookingPlain.paymentType, {
                laundrySubtotal: servicesSubtotal,
                serviceFee,
                minimumOrderPayment,
                driverTip: tipAmount,
                discount: parseFloat(billing.discount || 0),
                currency,
                currencySymbol,
            }),
            {
                paymentType: bookingPlain.paymentType,
                balancePaymentMethod: bookingPlain.balancePaymentMethod,
                balanceCollectedVia: bookingPlain.balanceCollectedVia,
                billingPaymentStatus: billing.paymentStatus,
            }
        );

        const failureCode = bookingPlain.lastPaymentFailureCode || null;
        const failureMessage = bookingPlain.lastPaymentFailureMessage || null;
        const paymentFailed =
            Boolean(failureCode) ||
            bookingPlain.autoChargeStatus === "failed" ||
            String(billing.paymentStatus || "").toLowerCase() === "failed";
        const paymentIssue = paymentFailed
            ? {
                  paymentFailed: true,
                  paymentFailureCode: failureCode,
                  paymentFailureReason: formatPaymentFailureReason(
                      failureCode,
                      failureMessage
                  ),
                  paymentFailureRawMessage: failureMessage,
                  paymentFailureAt: bookingPlain.lastPaymentFailureAt || null,
                  canUpdatePaymentMethod:
                      bookingPlain.paymentType === "card" &&
                      ![17, 19, 20, 21].includes(Number(bookingPlain.bookingStatusId)),
              }
            : {
                  paymentFailed: false,
                  paymentFailureCode: null,
                  paymentFailureReason: null,
                  paymentFailureRawMessage: null,
                  paymentFailureAt: null,
                  canUpdatePaymentMethod: false,
              };

        const hasInvoiceTotals =
            bookingPlain.invoiceStatus === "finalized" ||
            bookingPlain.invoiceStatus === "draft" ||
            servicesSubtotal > 0;

        let customerDeclaredServices = [];
        let agentAddedServices = [];
        try {
            customerDeclaredServices =
                await getFrozenCustomerDeclaredServices(bookingPlain.id);
        } catch (err) {
            console.warn(
                '[bookingDetailsById] customerDeclaredServices skipped:',
                err?.message || err
            );
        }
        try {
            agentAddedServices = await getAgentAddedServicesForCustomer(
                bookingPlain.id,
                customerDeclaredServices,
                bookingPlain.customerSelectedServices
            );
        } catch (err) {
            console.warn(
                '[bookingDetailsById] agentAddedServices skipped:',
                err?.message || err
            );
        }

        const proofOfDeliveriesList = Array.isArray(bookingPlain.proofOfDeliveries)
            ? bookingPlain.proofOfDeliveries
            : [];
        const pickupProofNote = extractProofNote(proofOfDeliveriesList, "pickUp");
        const deliveryProofNote = extractProofNote(proofOfDeliveriesList, "dropOff");

        const track = buildOrderTrackTimeline(bookingPlain);

        let bookingRepairItems = bookingPlain.repairItems || [];
        try {
            if (!Array.isArray(bookingRepairItems) || bookingRepairItems.length === 0) {
                bookingRepairItems = await getBookingRepairItems(bookingPlain.id);
            }
        } catch (err) {
            console.warn(
                '[bookingDetailsById] repairItems for item count skipped:',
                err?.message || err
            );
        }

        let refunds = {
            totalRefunded: 0,
            count: 0,
            isFullyRefunded: Number(bookingPlain.bookingStatusId) === 21,
            latest: null,
            history: [],
        };
        try {
            refunds = await getPublicRefundSummary(bookingPlain.id);
            refunds.isFullyRefunded =
                Number(bookingPlain.bookingStatusId) === 21 ||
                (refunds.totalRefunded > 0 &&
                    Number(paymentSummary?.amountDueNow || 0) <= 0.02 &&
                    refunds.totalRefunded + 0.02 >=
                        Number(paymentSummary?.orderSummary?.totalOrderAmount || 0));
        } catch (err) {
            console.warn(
                '[bookingDetailsById] refunds summary skipped:',
                err?.message || err
            );
        }

        const resultData = {
            ...bookingPlain,
            servicesSubtotal,
            invoiceGenerated: hasInvoiceTotals,
            customerDeclaredServices,
            agentAddedServices,
            totalItems: computePhysicalTotalItems({
                customerSelectedServices: bookingPlain.customerSelectedServices,
                customerDeclaredServices,
                repairItems: bookingRepairItems,
            }),
            paymentSummary,
            paymentIssue,
            cardDetails,
            cancellationPolicy,
            noShowPolicy,
            cancellationSummary,
            noShowSummary,
            orderStatusContext,
            pickupProofNote,
            deliveryProofNote,
            extraTip,
            refunds,
            trackTimeline: track.timeline,
            trackCurrentStatus: track.currentStatus,
            actionRequired: track.actionRequired,
        };

        if (hasInvoiceTotals) {
            const fullOrderTotal = paymentSummary.orderSummary.totalOrderAmount;
            resultData.subTotal = fullOrderTotal;
            resultData.orderAmount = fullOrderTotal;
            if (resultData.billingDetail) {
                resultData.billingDetail = {
                    ...resultData.billingDetail,
                    total: fullOrderTotal,
                    balanceDue: paymentSummary.amountDueNow,
                };
            }
        }

        delete resultData.cancellationPolicyBookings;
        delete resultData.noShowPolicyBookings;
        delete resultData.attempts;

        return {
            message: "Customer Order Details Fetched",
            data: resultData
        };
    }

    /**
     * Dedicated customer track-order payload (detailed timeline).
     */
    async trackOrder(data) {
        const detail = await this.bookingDetailsById(data);
        const bookingData = detail?.data || {};

        return {
            message: "Order track timeline fetched",
            data: {
                id: bookingData.id,
                orderTrackId: bookingData.orderTrackId,
                bookingStatusId: bookingData.bookingStatusId,
                bookingStatus: bookingData.bookingStatus,
                collectionDate: bookingData.collectionDate,
                collectionTimeFrom: bookingData.collectionTimeFrom,
                collectionTimeTo: bookingData.collectionTimeTo,
                deliveryDate: bookingData.deliveryDate,
                deliveryTimeFrom: bookingData.deliveryTimeFrom,
                deliveryTimeTo: bookingData.deliveryTimeTo,
                pickupAddress: bookingData.pickupAddress,
                dropOffAddress: bookingData.dropOffAddress,
                pickupAttemptCount: bookingData.pickupAttemptCount,
                pickupRescheduleRequired: bookingData.pickupRescheduleRequired,
                deliveryAttemptCount: bookingData.deliveryAttemptCount,
                currentStatus: bookingData.trackCurrentStatus,
                actionRequired: bookingData.actionRequired,
                timeline: bookingData.trackTimeline || [],
            },
        };
    }

    /**
     * Get All Services
     * @returns {Object} - Result object with services data
     */
    async allServices() {
        const rows = await service.findAll({
            where: { status: true },
            order: [['sortOrder', 'ASC']],
        });

        if (!rows || rows.length === 0) {
            throw new NotFoundError("No Services Found");
        }

        const serviceData = rows.map((row) => {
            const plain = row.toJSON ? row.toJSON() : row;
            return {
                ...plain,
                numberOfBags: Boolean(plain.numberOfBags),
                numberOfItems: Boolean(plain.numberOfItems),
                washBleedDisclaimerEnabled: Boolean(plain.washBleedDisclaimerEnabled),
            };
        });

        return {
            message: "All Services",
            data: { serviceData },
        };
    }

    /**
     * Get Service Detail by ID
     * @param {Object} data - Request data
     * @returns {Object} - Result object with service details
     */
    async serviceDetail(data = {}) {
        const { lat, lng, zoneId: requestedZoneId } = data;
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
                'washBleedDisclaimerEnabled',
            ],
            order: [['sortOrder', 'ASC']],
        });

        if (!activeServices || activeServices.length === 0) {
            throw new NotFoundError('No Service Details Found');
        }

        const result = [];
        let catalogZoneId = Number(requestedZoneId) > 0 ? Number(requestedZoneId) : null;
        if (!catalogZoneId && lat != null && lng != null) {
            const parsedLat = parseFloat(lat);
            const parsedLng = parseFloat(lng);
            if (Number.isFinite(parsedLat) && Number.isFinite(parsedLng)) {
                const matchedZones = await findZones(parsedLat, parsedLng);
                catalogZoneId = matchedZones?.[0]?.id || null;
            }
        }

        for (const svc of activeServices) {
            let serviceCategoriesData =
                await serviceManagementService.getServiceCategoriesDataForService(
                    svc.id
                );
            serviceCategoriesData =
                await zoneCatalogService.applyToServiceCategoriesData(
                    serviceCategoriesData,
                    catalogZoneId,
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
                    washBleedDisclaimerEnabled: Boolean(svc.washBleedDisclaimerEnabled),
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

        // Resolve currency: prefer the customer's saved/selected address (lat/lng),
        // fall back to the platform's default (first active) zone if not available.
        let resolvedZone = null;
        const parsedLat = lat !== undefined && lat !== null && lat !== '' ? parseFloat(lat) : NaN;
        const parsedLng = lng !== undefined && lng !== null && lng !== '' ? parseFloat(lng) : NaN;

        if (Number.isFinite(parsedLat) && Number.isFinite(parsedLng)) {
            try {
                const matchedZones = await findZones(parsedLat, parsedLng);
                resolvedZone = Array.isArray(matchedZones) ? matchedZones[0] : matchedZones;
            } catch (err) {
                console.warn('serviceDetail: zone lookup by coordinates failed, falling back to default zone:', err.message);
            }
        }

        if (!resolvedZone) {
            resolvedZone = await zone.findOne({
                where: { status: true },
                include: zoneInclude,
                attributes: zoneAttributes,
                order: [['id', 'ASC']],
            });
        }

        const currency = resolvedZone?.currencyUnitZ
            ? {
                  id: resolvedZone.currencyUnitZ.id,
                  name: resolvedZone.currencyUnitZ.name,
                  symbol: resolvedZone.currencyUnitZ.symbol,
              }
            : { id: null, name: null, symbol: '$' };

        return {
            message: 'Service Details',
            data: {
                serviceData: result,
                currency,
                catalogZoneId,
                pricesFinal: Boolean(catalogZoneId),
            },
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
        const { lat, lng, subCategoryIds, addOnServiceIds, repairOptionIds } = data;

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
        let ianaTimeZone = zoneData[0].city.country.ianaTimeZone || null;
        let currencyUnitId = zoneData[0].currencyUnitId;
        let currencyUnit = zoneData[0].currencyUnitZ;

        console.log("Zone found successfully:", { zoneId, zoneName, cityName, countryName, currency: currencyUnit?.name });

        const zoneCatalogService = require("../Admin/zoneCatalogService");
        let cart = null;
        if (subCategoryIds || addOnServiceIds || repairOptionIds) {
            cart = await zoneCatalogService.repriceCart(zoneId, {
                subCategoryIds,
                addOnServiceIds,
                repairOptionIds,
            });
        }

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
                ianaTimeZone,
                operationalTimeZone: ianaTimeZone,
                currencyUnitId,
                currency: currencyUnit ? {
                    id: currencyUnit.id,
                    name: currencyUnit.name,
                    symbol: currencyUnit.symbol
                } : null,
                cart,
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

        let ephemeralKeySecret = null;
        try {
            const ephemeralKey = await createEphemeralKey(customerId);
            ephemeralKeySecret = ephemeralKey.secret;
        } catch (ekErr) {
            console.warn(
                "[createIntentUsingStripe] ephemeral key failed (saved cards may be hidden):",
                ekErr.message
            );
        }

        let intentData = {
            setupIntentId: setupIntent.id,
            clientSecret: setupIntent.client_secret,
            customerId: customerId,
            ephemeralKeySecret,
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

const customerOrderService = new CustomerOrderService();
customerOrderService.bookingEventSentCheckTheShops = bookingEventSentCheckTheShops;
customerOrderService.findPreferredShopForCustomer = findPreferredShopForCustomer;
customerOrderService.notifyPreferredShopOnly = notifyPreferredShopOnly;
module.exports = customerOrderService;

require('dotenv').config();
const {
    booking,
    bookingHistory,
    users,
    policy,
    reschedulePolicyConfig,
    addressDb,
    agentSelectServices,
    bussinessInformation,
    billingDetails,
    customerSelectedService,
    bookingPreference,
    serviceWithPreferences,
    preferenceValues,
    service,
    categories,
    subCategories,
    zone
} = require('../../models');
const { Op } = require('sequelize');
const moment = require('moment-timezone');
const { assertDeliveryMeetsTurnaround } = require('../../utils/turnaroundTime');
const {
    ValidationError,
    NotFoundError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');
const { sendEvent } = require('../../socket_io');
const { chargeOffSession } = require('../../controllers/stripe');
const { buildStripeChargePresentation } = require('../../utils/stripePaymentMetadata');
const { isShopOpenNow, isAnyShopOpenInZone, isPlatformOpenNow, isShopEligibleForBroadcast } = require('../../utils/shopWorkingHours');
const {
    getOrderExpireTime,
    BUSINESS_TIME_ZONE,
} = require('../../utils/bookingTimeZone');
const { getCountryContextFromZoneId } = require('../../utils/countryTimeZone');
const { getAfterHoursOrderExpireTime } = require('../../utils/afterHoursBooking');
const { sendNotification } = require('../../utils/notification');

// Booking status IDs relevant to failed-attempt recovery on reschedule.
const AWAITING_COLLECTION_STATUS_ID = 3;
const COMPLETED_AT_FACILITY_STATUS_ID = 12;
const DELIVERY_FAILED_STATUS_ID = 15;

/**
 * Helper: find shops in zone available for a given time slot
 * Used to re-trigger the booking event after reschedule (status 1 only)
 */
async function findAvailableShopsAndNotify(bookingId, updatedBooking) {
    const {
        zoneId,
        collectionDate,
        collectionTimeFrom,
        collectionTimeTo,
        deliveryDate,
        deliveryTimeFrom,
        deliveryTimeTo
    } = updatedBooking;

    const countryCtx = await getCountryContextFromZoneId(zoneId);

    // The booking's distinct selected service IDs. Only shops that actively offer
    // ALL of them are eligible to receive the rescheduled booking.
    const selectedServiceRows = await customerSelectedService.findAll({
        where: { bookingId },
        attributes: ['serviceId'],
    });
    const requiredServiceIds = [
        ...new Set(
            selectedServiceRows
                .map((s) => Number(s.serviceId))
                .filter((id) => Number.isFinite(id) && id > 0)
        ),
    ];

    // Fetch all laundry shops in the zone
    const shopsInZone = await addressDb.findAll({
        where: {
            zoneId: zoneId,
            addressType: 'LaundaryShopAddress'
        },
        include: [
            {
                model: users,
                attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum'],
                required: false,
                include: [
                    {
                        model: agentSelectServices,
                        as: 'agentServices',
                        where: requiredServiceIds.length > 0
                            ? { serviceId: { [Op.in]: requiredServiceIds }, status: true }
                            : undefined,
                        attributes: ['id', 'serviceId'],
                        required: false
                    },
                    {
                        model: bussinessInformation,
                        as: 'businessInfo',
                        attributes: ['shopName'],
                        required: false
                    }
                ]
            }
        ],
        attributes: ['id', 'status', 'zoneId', 'userId']
    });

    // Check which shops have no conflicting bookings on the new time slot
    const availableShops = [];
    for (const shop of shopsInZone) {
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

        const conflictingBookings = await booking.findAll({
            where: {
                laundryShopId: shop.id,
                id: { [Op.ne]: bookingId },
                [Op.or]: [
                    {
                        [Op.and]: [
                            { collectionDate: collectionDate },
                            { collectionTimeFrom: { [Op.lt]: collectionTimeTo } },
                            { collectionTimeTo: { [Op.gt]: collectionTimeFrom } }
                        ]
                    },
                    {
                        [Op.and]: [
                            { deliveryDate: deliveryDate },
                            { deliveryTimeFrom: { [Op.lt]: deliveryTimeTo } },
                            { deliveryTimeTo: { [Op.gt]: deliveryTimeFrom } }
                        ]
                    }
                ]
            }
        });
        if (!conflictingBookings || conflictingBookings.length === 0) {
            const ownerId = shop.user?.id || shop.userId;
            if (
                await isShopEligibleForBroadcast(
                    ownerId,
                    countryCtx.countryId,
                    countryCtx.ianaTimeZone,
                    null,
                    {
                        collectionDate,
                        collectionTimeFrom,
                        collectionTimeTo,
                    }
                )
            ) {
                availableShops.push(shop);
            }
        }
    }

    if (availableShops.length === 0) {
        console.log('⚠️ Reschedule: No available/open shops for new time slot — no event sent');
        return { notifiedCount: 0 };
    }

    // Fetch full booking details for the event payload
    const bookingDetails = await booking.findOne({
        where: { id: bookingId },
        include: [
            {
                model: users,
                as: 'customer',
                attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'userTypeId', 'image']
            },
            {
                model: addressDb,
                as: 'pickupAddress',
                attributes: ['id', 'streetAddress', 'district', 'province', 'postalcode', 'lat', 'lng', 'addressType']
            },
            {
                model: billingDetails,
                as: 'billingDetail',
                attributes: ['total', 'serviceCharge', 'categoryCharge']
            },
            {
                model: zone,
                attributes: ['id', 'zoneMinimumAmount', 'serviceCharge', 'currencyUnitId']
            }
        ]
    });

    const eventData = {
        type: 'bookingRescheduled',
        data: {
            id: bookingDetails.id,
            orderTrackId: bookingDetails.orderTrackId,
            collectionDate: new Date(collectionDate).toISOString(),
            collectionTimeFrom,
            collectionTimeTo,
            deliveryDate: new Date(deliveryDate).toISOString(),
            deliveryTimeFrom,
            deliveryTimeTo,
            driverInstructionOptions: bookingDetails.driverInstructionOptions || null,
            driverInstructionOptions1: bookingDetails.driverInstructionOptions1 || null,
            driverInstruction: bookingDetails.driverInstruction || null,
            paymentConfirmed: bookingDetails.paymentConfirmed || false,
            partialPayment: bookingDetails.partialPayment || false,
            totalItems: bookingDetails.totalItems || 0,
            orderAmount: bookingDetails?.billingDetail?.total || 0,
            frequency: bookingDetails.frequency || 'Just Once',
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
                phoneNum: bookingDetails.customer.phoneNum
            },
            zone: bookingDetails.zone || {},
            isRescheduled: true,
            rescheduledCount: bookingDetails.rescheduledCount
        }
    };

    let notifiedCount = 0;
    availableShops.forEach((shop) => {
        if (shop.user && shop.user.id) {
            sendEvent(shop.user.id, eventData);
            notifiedCount += 1;
            console.log(`📡 Reschedule event sent to shop owner: ${shop.user.id}`);
        } else {
            console.warn(`⚠️ Skipping shop ${shop.id} - no associated user found`);
        }
    });
    return { notifiedCount };
}

/**
 * Customer Reschedule Booking Service
 * Handles reschedule with policy enforcement and re-notification when not yet accepted
 */
class RescheduleBookingService {
    async _notifyAssignedAgentOnReschedule(bookingData) {
        try {
            let targetUserId = bookingData?.driverId ? Number(bookingData.driverId) : null;

            // Fallback to assigned shop owner only if no driver is currently assigned.
            if (!targetUserId) {
                const assignedShopAddressId = bookingData?.adminAssignedShopId || bookingData?.laundryShopId;
                if (assignedShopAddressId) {
                    const shopAddress = await addressDb.findOne({
                        where: { id: assignedShopAddressId },
                        attributes: ['id', 'userId'],
                    });
                    if (shopAddress?.userId) {
                        targetUserId = Number(shopAddress.userId);
                    }
                }
            }

            if (!targetUserId) return;

            sendNotification(
                targetUserId,
                'Booking rescheduled by customer',
                `Order #${bookingData.orderTrackId || bookingData.id} has been rescheduled by the customer.`,
                {
                    bookingId: bookingData.id,
                    orderTrackId: bookingData.orderTrackId,
                    eventType: 'booking_rescheduled_by_customer',
                }
            );
        } catch (err) {
            console.error('[reschedule] Failed to send agent notification:', err?.message || err);
        }
    }

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
     * Reschedule a booking
     * @param {number} bookingId
     * @param {number} customerId
     * @param {Object} newSchedule - { collectionDate, collectionTimeFrom, collectionTimeTo, deliveryDate, deliveryTimeFrom, deliveryTimeTo }
     * @param {string} reasonText
     * @param {Array}  services        - Optional. New services array [{ serviceId, categoryId, subCategoryId, categoryCharge }]
     * @param {Array}  preferencesArray - Optional. New preferences [{ preferenceTypeId, preferenceValueId, serviceId? }]
     * @returns {Object} Reschedule result with fee info
     */
    async rescheduleCustomerBooking(bookingId, customerId, newSchedule, reasonText, services, preferencesArray) {
        const {
            collectionDate,
            collectionTimeFrom,
            collectionTimeTo,
            deliveryDate,
            deliveryTimeFrom,
            deliveryTimeTo,
            timeZone,
            rescheduleType,
        } = newSchedule;
        const isDeliveryOnlyReschedule = rescheduleType === 'delivery';

        const scheduleTotalBags =
            newSchedule.totalBags != null && newSchedule.totalBags !== ""
                ? Number(newSchedule.totalBags)
                : null;
        const scheduleSameBagForAllServices =
            newSchedule.sameBagForAllServices !== false;
        const scheduleTotalItems =
            newSchedule.totalItems != null && newSchedule.totalItems !== ""
                ? Number(newSchedule.totalItems)
                : null;

        // Normalize time strings to HH:mm:ss, store as-is
        const normalizedCollectionTimeFrom = this._getTimePart(collectionTimeFrom, 'collectionTimeFrom');
        const normalizedCollectionTimeTo   = this._getTimePart(collectionTimeTo,   'collectionTimeTo');
        const normalizedDeliveryTimeFrom   = this._getTimePart(deliveryTimeFrom,   'deliveryTimeFrom');
        const normalizedDeliveryTimeTo     = this._getTimePart(deliveryTimeTo,     'deliveryTimeTo');
        const normalizedCollectionDate     = this._getDatePart(collectionDate,     'collectionDate');
        const normalizedDeliveryDate       = this._getDatePart(deliveryDate,       'deliveryDate');

        // Step 1: Fetch booking and verify ownership
        const bookingData = await booking.findOne({
            where: {
                id: bookingId,
                customerId: customerId
            },
            attributes: [
                'id', 'customerId', 'bookingStatusId', 'zoneId',
                'collectionDate', 'collectionTimeFrom', 'collectionTimeTo',
                'deliveryDate', 'deliveryTimeFrom', 'deliveryTimeTo',
                'orderAmount', 'paymentConfirmed', 'rescheduledCount',
                'laundryShopId', 'orderTrackId', 'frequency',
                'driverInstructionOptions', 'driverInstructionOptions1',
                'driverInstruction', 'totalItems',                 'pickupAddresId', 'dropOffAddressId',
                'paymentMethodId', 'paymentType', 'driverId', 'adminAssignedShopId',
                'pickupAttemptCount', 'pickupRescheduleRequired', 'deliveryAttemptCount'
            ]
        });

        if (!bookingData) {
            throw new NotFoundError("Booking not found or you don't have permission to reschedule this booking");
        }

        // Step 2: Status validation — block invalid states
        const statusId = bookingData.bookingStatusId;

        if (statusId === 11) {
            throw new ValidationError("Cannot reschedule booking. Items are currently being processed at the facility");
        }
        if (statusId === 19) {
            throw new ConflictError("Cannot reschedule a cancelled booking");
        }
        if ([16, 17].includes(statusId)) {
            throw new ValidationError("Cannot reschedule a completed booking");
        }
        if (statusId === 14) {
            throw new ValidationError("Cannot reschedule booking at this stage. Items are out for delivery");
        }

        // Step 3: Validate new dates are in the future
        // Use the frontend timezone if provided, otherwise fall back to business timezone
        const resolvedTz = (timeZone && moment.tz.zone(timeZone.trim()))
            ? timeZone.trim()
            : BUSINESS_TIME_ZONE;

        const newCollectionMoment = moment.tz(
            `${normalizedCollectionDate} ${normalizedCollectionTimeFrom}`,
            'YYYY-MM-DD HH:mm:ss',
            resolvedTz
        );

        // For delivery-only reschedules (status 15), pickup already happened — skip collection future check
        if (!isDeliveryOnlyReschedule && newCollectionMoment.isBefore(moment.tz(resolvedTz))) {
            throw new ValidationError("New collection date and time must be in the future");
        }

        const newDeliveryMoment = moment.tz(
            `${normalizedDeliveryDate} ${normalizedDeliveryTimeFrom}`,
            'YYYY-MM-DD HH:mm:ss',
            resolvedTz
        );
        if (newDeliveryMoment.isBefore(moment.tz(resolvedTz))) {
            throw new ValidationError("New delivery date and time must be in the future");
        }

        let rescheduleServiceIds = (services || []).map((s) => s.serviceId).filter(Boolean);
        if (!rescheduleServiceIds.length) {
            const existingRows = await customerSelectedService.findAll({
                where: { bookingId, status: true },
                attributes: ['serviceId'],
            });
            rescheduleServiceIds = existingRows.map((r) => r.serviceId).filter(Boolean);
        }
        await assertDeliveryMeetsTurnaround(
            service,
            rescheduleServiceIds,
            normalizedCollectionDate,
            normalizedDeliveryDate,
            ValidationError
        );

        // Step 4: Get active reschedule policy for the booking's zone
        const activePolicy = await this.getActiveReschedulePolicy(bookingData.zoneId);

        // Step 5: Calculate reschedule fee based on booking phase
        const feeDetails = await this.calculateRescheduleFee(bookingData, activePolicy, customerId);

        // Step 6: Update services if provided
        let newOrderAmount = bookingData.orderAmount; // keep existing amount if no services sent
        const servicesUpdated = services && services.length > 0;

        if (servicesUpdated) {
            const currentDate = new Date().toISOString().split('T')[0];
            const currentTime = new Date().toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit', hour12: false
            });

            // Delete all existing selected services for this booking
            await customerSelectedService.destroy({ where: { bookingId } });

            // Recalculate total from new services
            const categoryCharge = services.reduce(
                (acc, s) => acc + parseFloat(s.categoryCharge || 0), 0
            );
            newOrderAmount = categoryCharge;

            // Build and bulk-insert new service rows
            const serviceRows = services.map((s) => {
                const row = {
                    bookingId,
                    serviceId: s.serviceId,
                    date: currentDate,
                    time: currentTime
                };
                if (s.categoryId)    row.categoryId    = s.categoryId;
                if (s.subCategoryId) row.subCategoryId = s.subCategoryId;
                if (s.categoryCharge) row.categoryPrice = parseFloat(s.categoryCharge);
                if (s.serviceInstruction) row.serviceInstruction = s.serviceInstruction;
                if (s.items != null && s.items !== "") row.items = Number(s.items);
                const bagVal = s.bags ?? s.bagsCount;
                if (bagVal != null && bagVal !== "") {
                    const n = Number(bagVal);
                    if (Number.isFinite(n) && n > 0) row.bags = Math.floor(n);
                }
                return row;
            });
            await customerSelectedService.bulkCreate(serviceRows);
            console.log(`✅ Reschedule: replaced ${serviceRows.length} service(s) for booking ${bookingId}`);

            // Update billing details total with new category charge
            await billingDetails.update(
                { total: categoryCharge },
                { where: { bookingId } }
            );
        }

        // Step 7: Update preferences if provided (only when services are also updated)
        if (servicesUpdated && preferencesArray && preferencesArray.length > 0) {
            const serviceIds = services.map((s) => s.serviceId);

            // Delete all existing booking preferences
            await bookingPreference.destroy({ where: { bookingId } });

            const prefsToCreate = [];

            for (const pref of preferencesArray) {
                const { preferenceTypeId, preferenceValueId, serviceId, parentPreferenceValueId } = pref;

                if (!preferenceTypeId || !preferenceValueId) {
                    throw new ValidationError(
                        'preferenceTypeId and preferenceValueId are required for each preference'
                    );
                }

                // Validate preference belongs to the service(s) in this booking
                const targetServiceIds = serviceId ? [serviceId] : serviceIds;
                const prefExists = await serviceWithPreferences.findOne({
                    where: {
                        serviceId: { [Op.in]: targetServiceIds },
                        preferenceTypeId,
                        status: true
                    }
                });
                if (!prefExists) {
                    throw new ValidationError(
                        `Preference type ${preferenceTypeId} is not available for the selected service(s)`
                    );
                }

                // Validate preference value belongs to preference type
                const prefValue = await preferenceValues.findOne({
                    where: { id: preferenceValueId, preferenceTypeId, status: true }
                });
                if (!prefValue) {
                    throw new ValidationError(
                        `Preference value ${preferenceValueId} is invalid or does not belong to preference type ${preferenceTypeId}`
                    );
                }

                prefsToCreate.push({
                    bookingId,
                    preferenceTypeId,
                    preferenceValueId,
                    parentPreferenceValueId: parentPreferenceValueId || null
                });
            }

            if (prefsToCreate.length > 0) {
                await bookingPreference.bulkCreate(prefsToCreate);
                console.log(`✅ Reschedule: replaced ${prefsToCreate.length} preference(s) for booking ${bookingId}`);
            }
        } else if (servicesUpdated) {
            // Services changed but no new preferences sent — clear old preferences
            await bookingPreference.destroy({ where: { bookingId } });
        }

        // Step 7.5: Stripe off-session charge when policy fee > 0 (same pattern as cancellation)
        let stripeChargeResult = null;
        let stripeChargeError = null;
        const chargeAmount = parseFloat(feeDetails.rescheduleCharge);
        if (chargeAmount > 0) {
            const savedPaymentMethodId = bookingData.paymentMethodId;

            if (savedPaymentMethodId) {
                const customerData = await users.findOne({
                    where: { id: customerId },
                    attributes: [
                        'id',
                        'firstName',
                        'lastName',
                        'email',
                        'stripeCustomerId',
                    ],
                });

                if (customerData?.stripeCustomerId) {
                    try {
                        const idempotencyKey = `reschedule-booking-${bookingId}-customer-${customerId}-n${bookingData.rescheduledCount + 1}`;
                        const stripePresentation = buildStripeChargePresentation({
                            chargeType: "reschedule_fee",
                            bookingId,
                            orderTrackId: bookingData.orderTrackId,
                            amount: chargeAmount,
                            currency: feeDetails.currency || "GBP",
                            paymentType: bookingData.paymentType || "card",
                            customer: customerData,
                            agent: {},
                            zoneId: bookingData.zoneId,
                            laundryShopId: bookingData.laundryShopId,
                            extra: {
                                rescheduledCount: bookingData.rescheduledCount + 1,
                            },
                        });
                        stripeChargeResult = await chargeOffSession(
                            chargeAmount,
                            customerData.stripeCustomerId,
                            savedPaymentMethodId,
                            idempotencyKey,
                            stripePresentation
                        );
                        console.log(
                            `✅ Reschedule charge of ${chargeAmount} ${feeDetails.currency} charged for booking ${bookingId}`
                        );
                    } catch (chargeErr) {
                        stripeChargeError = chargeErr.message || String(chargeErr);
                        console.error(
                            `❌ Failed to charge reschedule fee for booking ${bookingId}:`,
                            stripeChargeError
                        );
                    }
                } else {
                    stripeChargeError = 'No Stripe customer ID found for this customer';
                    console.warn(
                        `⚠️ Cannot charge reschedule fee — no stripeCustomerId for customer ${customerId}`
                    );
                }
            } else {
                stripeChargeError = 'No saved payment method found for this booking';
                console.warn(
                    `⚠️ Cannot charge reschedule fee — no paymentMethodId on booking ${bookingId}`
                );
            }
        }

        // Resolve booking status after reschedule when recovering from a failed attempt:
        //  - Delivery Failed (15): items are washed & ready at facility → move to
        //    Completed (At Facility, 12) so the agent can re-dispatch delivery on the new slot.
        //  - Pickup Failed: stay Awaiting Collection and clear only the unresolved
        //    reschedule flag. Keep pickupAttemptCount cumulative for policy limits.
        const isPickupFailed =
            statusId === AWAITING_COLLECTION_STATUS_ID &&
            Boolean(bookingData.pickupRescheduleRequired);
        let resolvedBookingStatusId = statusId;
        const statusResetFields = {};
        if (statusId === DELIVERY_FAILED_STATUS_ID) {
            resolvedBookingStatusId = COMPLETED_AT_FACILITY_STATUS_ID;
            statusResetFields.bookingStatusId = COMPLETED_AT_FACILITY_STATUS_ID;
        } else if (isPickupFailed) {
            resolvedBookingStatusId = AWAITING_COLLECTION_STATUS_ID;
            statusResetFields.pickupRescheduleRequired = false;
        }

        // Step 8: Update booking with new dates, new order amount and reschedule metadata
        await booking.update(
            {
                collectionDate: normalizedCollectionDate,
                collectionTimeFrom: normalizedCollectionTimeFrom,
                collectionTimeTo: normalizedCollectionTimeTo,
                deliveryDate: normalizedDeliveryDate,
                deliveryTimeFrom: normalizedDeliveryTimeFrom,
                deliveryTimeTo: normalizedDeliveryTimeTo,
                orderAmount: newOrderAmount,
                rescheduledCount: bookingData.rescheduledCount + 1,
                rescheduleReason: reasonText || null,
                rescheduleCharge: feeDetails.rescheduleCharge,
                ...(scheduleTotalBags != null ? { totalBags: scheduleTotalBags } : {}),
                sameBagForAllServices: scheduleSameBagForAllServices,
                ...(scheduleTotalItems != null ? { totalItems: scheduleTotalItems } : {}),
                ...statusResetFields,
            },
            { where: { id: bookingId } }
        );

        // Step 9: Add booking history entry using caller/business timezone wall-clock
        const rescheduleMoment = moment.tz(resolvedTz);
        await bookingHistory.create({
            bookingId,
            bookingStatusId: resolvedBookingStatusId,
            date: rescheduleMoment.format('YYYY-MM-DD'),
            time: rescheduleMoment.format('HH:mm:ss')
        });

        // Notify assigned agent/shop owner that customer changed schedule.
        await this._notifyAssignedAgentOnReschedule(bookingData);

        // Step 10: If status is 1 (created, no agent accepted yet) re-fire the booking event
        // so agents are notified of the updated schedule and services
        if (statusId === 1) {
            const countryCtx = await getCountryContextFromZoneId(bookingData.zoneId);
            const platformOpenNow = await isPlatformOpenNow(
                countryCtx.countryId,
                resolvedTz
            );
            const zoneOpenNow = await isAnyShopOpenInZone(
                bookingData.zoneId,
                resolvedTz
            );

            if (!platformOpenNow) {
                const afterHoursExpiry = await getAfterHoursOrderExpireTime(
                    countryCtx.countryId,
                    resolvedTz,
                    null,
                    new Date()
                );
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
                    `[reschedule] booking ${bookingId} held (after-hours) — expires ${afterHoursExpiry.platformOpenDay} ${afterHoursExpiry.orderExpireTime}`
                );
                const { releaseHeldBookingsForZone } = require('../bookingHeldReleaseService');
                await releaseHeldBookingsForZone(bookingData.zoneId);
            } else if (zoneOpenNow) {
                console.log(
                    '🔄 Booking status is 1 — re-triggering agent notification with new schedule'
                );
                const visibleAt = new Date();
                const expireTime = getOrderExpireTime(resolvedTz);
                await booking.update(
                    {
                        agentBroadcastHeld: false,
                        agentVisibleAt: visibleAt,
                        orderExpireTime: expireTime,
                        placedOutsidePlatformHours: false,
                    },
                    { where: { id: bookingId } }
                );

                const notifyResult = await findAvailableShopsAndNotify(bookingId, {
                    zoneId: bookingData.zoneId,
                    collectionDate: normalizedCollectionDate,
                    collectionTimeFrom: normalizedCollectionTimeFrom,
                    collectionTimeTo: normalizedCollectionTimeTo,
                    deliveryDate: normalizedDeliveryDate,
                    deliveryTimeFrom: normalizedDeliveryTimeFrom,
                    deliveryTimeTo: normalizedDeliveryTimeTo,
                });
                const notifiedCount = notifyResult?.notifiedCount ?? 0;

                if (notifiedCount === 0) {
                    await booking.update(
                        {
                            agentBroadcastHeld: true,
                            agentVisibleAt: null,
                            orderExpireTime: null,
                            placedOutsidePlatformHours: false,
                        },
                        { where: { id: bookingId } }
                    );
                    console.log(
                        `[reschedule] booking ${bookingId} held — no agent notified`
                    );
                }
            } else {
                await booking.update(
                    {
                        agentBroadcastHeld: true,
                        agentVisibleAt: null,
                        orderExpireTime: null,
                        placedOutsidePlatformHours: false,
                    },
                    { where: { id: bookingId } }
                );
                console.log(
                    `[reschedule] booking ${bookingId} held — no shop open in zone`
                );
            }
        }

        return {
            bookingId,
            orderTrackId: bookingData.orderTrackId,
            status: 'rescheduled',
            rescheduledCount: bookingData.rescheduledCount + 1,
            servicesUpdated,
            newSchedule: {
                collectionDate: normalizedCollectionDate,
                collectionTimeFrom: normalizedCollectionTimeFrom,
                collectionTimeTo: normalizedCollectionTimeTo,
                deliveryDate: normalizedDeliveryDate,
                deliveryTimeFrom: normalizedDeliveryTimeFrom,
                deliveryTimeTo: normalizedDeliveryTimeTo
            },
            newOrderAmount,
            rescheduleCharge: feeDetails.rescheduleCharge,
            currency: feeDetails.currency,
            policyApplied: feeDetails.policyApplied,
            message: feeDetails.message,
            rescheduleFeeCharged: stripeChargeResult !== null,
            stripeChargeId: stripeChargeResult?.id || null,
            stripeChargeStatus: stripeChargeResult?.status || null,
            stripeChargeError
        };
    }

    /**
     * Get active reschedule policy for a specific zone.
     * Falls back to null (free reschedule) if no zone-specific policy is configured.
     * @param {number} zoneId
     */
    async getActiveReschedulePolicy(zoneId) {
        const now = new Date();
        const activePolicy = await policy.findOne({
            where: {
                type: 'reschedule',
                isActive: true,
                zoneId: zoneId,
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
            },
            include: [
                {
                    model: reschedulePolicyConfig,
                    as: 'rescheduleConfig',
                    required: false
                }
            ],
            order: [
                ['isDefault', 'DESC'],
                ['effectiveFrom', 'DESC'],
                ['createdAt', 'DESC']
            ]
        });

        return activePolicy || null;
    }

    /**
     * Calculate reschedule fee based on booking phase and policy config
     * Phase A (pre-pickup):  status 1, 2, 3    → atPickup charges
     * Phase B (post-pickup): status 4–10        → atDelivery charges
     */
    async calculateRescheduleFee(bookingData, activePolicy, customerId) {
        const statusId = bookingData.bookingStatusId;
        const config = activePolicy?.rescheduleConfig;

        // No policy or no config → free reschedule
        if (!config) {
            return {
                rescheduleCharge: 0,
                currency: 'GBP',
                policyApplied: 'Free Reschedule',
                message: 'No reschedule charges applied (no active policy)'
            };
        }

        // ReschedulePolicyConfig.isActive — when false, no monetary charges
        if (config.isActive === false) {
            return {
                rescheduleCharge: 0,
                currency: config.atPickupAbsoluteCurrency || config.atDeliveryAbsoluteCurrency || 'GBP',
                policyApplied: 'Free Reschedule',
                message: 'No reschedule charges applied (reschedule policy config is inactive)'
            };
        }

        let charge = 0;
        let currency = 'GBP';
        let policyApplied = 'Free Reschedule';

        // ── Phase A: pre-pickup (status 1, 2, 3) ────────────────────────────────
        if ([1, 2, 3].includes(statusId)) {
            currency = config.atPickupAbsoluteCurrency || 'GBP';

            // Check courtesy count for pre-pickup phase
            if (config.atPickupCourtesyCountEnabled) {
                const recentReschedules = await this.countRecentReschedules(customerId, 30);
                if (recentReschedules < (config.atPickupCourtesyCount || 1)) {
                    return {
                        rescheduleCharge: 0,
                        currency,
                        policyApplied: 'Pre-Pickup Courtesy Reschedule',
                        message: `No charge — courtesy reschedule ${recentReschedules + 1} of ${config.atPickupCourtesyCount}`
                    };
                }
            }

            // Apply absolute amount
            if (config.atPickupAbsoluteAmount) {
                charge = parseFloat(config.atPickupAbsoluteAmount);
                policyApplied = 'Pre-Pickup Absolute Charge';
            }

            // Apply percentage if higher
            if (config.atPickupPercentage && bookingData.orderAmount) {
                const pctCharge = (parseFloat(bookingData.orderAmount) * parseFloat(config.atPickupPercentage)) / 100;
                if (pctCharge > charge) {
                    charge = pctCharge;
                    policyApplied = 'Pre-Pickup Percentage Charge';
                }
            }
        }

        // ── Phase B: post-pickup through delivery (status 4–10, 12–13, 15 delivery failed) ─────────
        else if ([4, 5, 6, 7, 8, 9, 10, 12, 13, 15].includes(statusId)) {
            currency = config.atDeliveryAbsoluteCurrency || 'GBP';

            // Check courtesy count for post-pickup phase
            if (config.atDeliveryCourtesyCountEnabled) {
                const recentReschedules = await this.countRecentReschedules(customerId, 30);
                if (recentReschedules < (config.atDeliveryCourtesyCount || 1)) {
                    return {
                        rescheduleCharge: 0,
                        currency,
                        policyApplied: 'Post-Pickup Courtesy Reschedule',
                        message: `No charge — courtesy reschedule ${recentReschedules + 1} of ${config.atDeliveryCourtesyCount}`
                    };
                }
            }

            // Apply absolute amount
            if (config.atDeliveryAbsoluteAmount) {
                charge = parseFloat(config.atDeliveryAbsoluteAmount);
                policyApplied = 'Post-Pickup Absolute Charge';
            }

            // Apply percentage if higher
            if (config.atDeliveryPercentage && bookingData.orderAmount) {
                const pctCharge = (parseFloat(bookingData.orderAmount) * parseFloat(config.atDeliveryPercentage)) / 100;
                if (pctCharge > charge) {
                    charge = pctCharge;
                    policyApplied = 'Post-Pickup Percentage Charge';
                }
            }
        }

        // Apply global leniency cap if enabled
        if (config.customerLeniencyEnabled && charge > 0 && config.courtesyCapAmount) {
            const recentReschedules = await this.countRecentReschedules(customerId, config.courtesyWindowDays || 30);
            if (recentReschedules < (config.courtesyCount || 1)) {
                charge = Math.min(charge, parseFloat(config.courtesyCapAmount));
                policyApplied = 'Customer Leniency Cap Applied';
            }
        }

        const finalCharge = parseFloat(charge.toFixed(2));

        return {
            rescheduleCharge: finalCharge,
            currency,
            policyApplied,
            message: finalCharge > 0
                ? `A reschedule charge of ${currency} ${finalCharge.toFixed(2)} will be applied`
                : 'No reschedule charges applied'
        };
    }

    /**
     * Count how many times a customer has rescheduled bookings within a window
     */
    async countRecentReschedules(customerId, windowDays) {
        const windowStart = moment().subtract(windowDays, 'days').toDate();
        const count = await booking.count({
            where: {
                customerId,
                rescheduledCount: { [Op.gt]: 0 },
                updatedAt: { [Op.gte]: windowStart }
            }
        });
        return count;
    }

    /**
     * Get reschedule history for a customer
     * @param {number} customerId
     * @param {number} days
     */
    async getCustomerRescheduleHistory(customerId, days = 30) {
        const windowStart = moment().subtract(days, 'days').toDate();

        const reschedules = await booking.findAll({
            where: {
                customerId,
                rescheduledCount: { [Op.gt]: 0 },
                updatedAt: { [Op.gte]: windowStart }
            },
            attributes: [
                'id', 'orderTrackId', 'collectionDate', 'collectionTimeFrom', 'collectionTimeTo',
                'deliveryDate', 'deliveryTimeFrom', 'deliveryTimeTo',
                'rescheduledCount', 'rescheduleReason', 'rescheduleCharge',
                'bookingStatusId', 'orderAmount', 'updatedAt'
            ],
            order: [['updatedAt', 'DESC']]
        });

        return {
            totalRescheduled: reschedules.length,
            windowDays: days,
            reschedules
        };
    }
}

module.exports = new RescheduleBookingService();

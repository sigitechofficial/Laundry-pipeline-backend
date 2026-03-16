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
const moment = require('moment');
const {
    ValidationError,
    NotFoundError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');
const { sendEvent } = require('../../socket_io');

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
                        attributes: ['id'],
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
            availableShops.push(shop);
        }
    }

    if (availableShops.length === 0) {
        console.log('⚠️ Reschedule: No available shops found for new time slot — no event sent');
        return;
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

    availableShops.forEach((shop) => {
        if (shop.user && shop.user.id) {
            sendEvent(shop.user.id, eventData);
            console.log(`📡 Reschedule event sent to shop owner: ${shop.user.id}`);
        } else {
            console.warn(`⚠️ Skipping shop ${shop.id} - no associated user found`);
        }
    });
}

/**
 * Customer Reschedule Booking Service
 * Handles reschedule with policy enforcement and re-notification when not yet accepted
 */
class RescheduleBookingService {

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
            deliveryTimeTo
        } = newSchedule;

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
                'driverInstruction', 'totalItems', 'pickupAddresId', 'dropOffAddressId'
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
        if ([14, 15].includes(statusId)) {
            throw new ValidationError("Cannot reschedule booking at this stage. Items are out for delivery");
        }

        // Step 3: Validate new dates are in the future
        const newCollectionMoment = moment(
            `${moment(collectionDate).format('YYYY-MM-DD')} ${collectionTimeFrom}`,
            'YYYY-MM-DD HH:mm:ss'
        );
        if (newCollectionMoment.isBefore(moment())) {
            throw new ValidationError("New collection date and time must be in the future");
        }

        const newDeliveryMoment = moment(
            `${moment(deliveryDate).format('YYYY-MM-DD')} ${deliveryTimeFrom}`,
            'YYYY-MM-DD HH:mm:ss'
        );
        if (newDeliveryMoment.isBefore(newCollectionMoment)) {
            throw new ValidationError("Delivery date must be after the collection date");
        }

        // Step 4: Get active reschedule policy
        const activePolicy = await this.getActiveReschedulePolicy();

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
                const { preferenceTypeId, preferenceValueId, serviceId } = pref;

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

                prefsToCreate.push({ bookingId, preferenceTypeId, preferenceValueId });
            }

            if (prefsToCreate.length > 0) {
                await bookingPreference.bulkCreate(prefsToCreate);
                console.log(`✅ Reschedule: replaced ${prefsToCreate.length} preference(s) for booking ${bookingId}`);
            }
        } else if (servicesUpdated) {
            // Services changed but no new preferences sent — clear old preferences
            await bookingPreference.destroy({ where: { bookingId } });
        }

        // Step 8: Update booking with new dates, new order amount and reschedule metadata
        await booking.update(
            {
                collectionDate,
                collectionTimeFrom,
                collectionTimeTo,
                deliveryDate,
                deliveryTimeFrom,
                deliveryTimeTo,
                orderAmount: newOrderAmount,
                rescheduledCount: bookingData.rescheduledCount + 1,
                rescheduleReason: reasonText || null,
                rescheduleCharge: feeDetails.rescheduleCharge
            },
            { where: { id: bookingId } }
        );

        // Step 9: Add booking history entry
        await bookingHistory.create({
            bookingId,
            bookingStatusId: statusId,
            date: moment().format('YYYY-MM-DD'),
            time: moment().format('HH:mm:ss')
        });

        // Step 10: If status is 1 (created, no agent accepted yet) re-fire the booking event
        // so agents are notified of the updated schedule and services
        if (statusId === 1) {
            console.log('🔄 Booking status is 1 (no agent accepted yet) — re-triggering agent notification with new schedule');
            await findAvailableShopsAndNotify(bookingId, {
                zoneId: bookingData.zoneId,
                collectionDate,
                collectionTimeFrom,
                collectionTimeTo,
                deliveryDate,
                deliveryTimeFrom,
                deliveryTimeTo
            });
        }

        return {
            bookingId,
            orderTrackId: bookingData.orderTrackId,
            status: 'rescheduled',
            rescheduledCount: bookingData.rescheduledCount + 1,
            servicesUpdated,
            newSchedule: {
                collectionDate,
                collectionTimeFrom,
                collectionTimeTo,
                deliveryDate,
                deliveryTimeFrom,
                deliveryTimeTo
            },
            newOrderAmount,
            rescheduleCharge: feeDetails.rescheduleCharge,
            currency: feeDetails.currency,
            policyApplied: feeDetails.policyApplied,
            message: feeDetails.message
        };
    }

    /**
     * Get active reschedule policy
     * Falls back to no-charge defaults if none configured
     */
    async getActiveReschedulePolicy() {
        const now = new Date();
        const activePolicy = await policy.findOne({
            where: {
                type: 'reschedule',
                isActive: true,
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

        // ── Phase B: post-pickup through delivery (status 4–10 and 12–13) ─────────
        else if ([4, 5, 6, 7, 8, 9, 10, 12, 13].includes(statusId)) {
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

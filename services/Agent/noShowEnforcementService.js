const moment = require('moment-timezone');
const { Op } = require('sequelize');
const {
    booking,
    bookingAttempt,
    bookingHistory,
    proofOfDeliveries,
    users,
} = require('../../models');
const { chargeOffSession } = require('../../controllers/stripe');
const { buildStripeChargePresentation } = require('../../utils/stripePaymentMetadata');
const {
    resolveNoShowPolicyForBooking,
    loadBookingForAttempts,
} = require('../../utils/safeNoShowPolicyQuery');
const { attachNoShowPolicyOnBooking } = require('../../utils/bookingPolicyAttach');
const { sendNotification } = require('../../utils/notification');
const {
    ValidationError,
    NotFoundError,
    ConflictError,
} = require('../../middlewares/universalErrorHandler');
const { assertDriverWithinCustomerRadius, getDriverGeofenceStatus } = require('../../utils/driverGeofence');

const PICKUP_ARRIVED_STATUS = 5;
const PICKUP_SUCCESS_STATUS = 7;
const AWAITING_COLLECTION_STATUS = 3;
const OUT_FOR_DELIVERY_STATUS = 13;
const DELIVERY_ARRIVED_STATUS = 14;
const DELIVERY_FAILED_STATUS = 15;
const READY_FOR_DELIVERY_STATUS = 12;
const CANCELLED_STATUS = 19;

const PICKUP_INSTRUCTION_UNATTENDED = new Set([
    'Collect from Outside',
    'Collect from reception/Porter',
    'Collect from the reception',
]);
const DELIVERY_INSTRUCTION_UNATTENDED = new Set([
    'Leave at the door',
    'Deliver to the Reception/Porter',
]);

class NoShowEnforcementService {
    _roundMoney(value) {
        return Math.round((parseFloat(value) || 0) * 100) / 100;
    }

    _normalizeAttemptType(type) {
        const normalized = String(type || '').trim().toLowerCase();
        if (normalized === 'pickup' || normalized === 'delivery') return normalized;
        throw new ValidationError('type must be pickup or delivery');
    }

    _expectedArrivedStatus(attemptType) {
        return attemptType === 'pickup' ? PICKUP_ARRIVED_STATUS : DELIVERY_ARRIVED_STATUS;
    }

    async _loadBooking(bookingId) {
        const row = await loadBookingForAttempts(bookingId);
        if (!row) throw new NotFoundError(`Booking ${bookingId} not found`);
        return row;
    }

    /**
     * Charge no-show fee on saved card (off-session). Non-blocking — caller still completes fail flow.
     */
    async _attemptNoShowFeeCharge({ bookingData, feeResult, attemptId, attemptType }) {
        const chargeAmount = parseFloat(feeResult?.feeAmount) || 0;
        if (chargeAmount <= 0 || feeResult?.feeWaived) {
            return { stripeChargeResult: null, stripeChargeError: null, stripeCharged: false };
        }

        const stripeBooking = await loadBookingForAttempts(bookingData.id, [
            'paymentMethodId',
            'paymentType',
            'orderTrackId',
            'adminAssignedShopId',
        ]);
        const paymentMethodId = stripeBooking?.paymentMethodId;
        if (!paymentMethodId) {
            return {
                stripeChargeResult: null,
                stripeChargeError: 'No saved payment method found for this booking',
                stripeCharged: false,
            };
        }

        const customerData = await users.findOne({
            where: { id: bookingData.customerId },
            attributes: ['id', 'firstName', 'lastName', 'email', 'stripeCustomerId'],
        });

        if (!customerData?.stripeCustomerId) {
            return {
                stripeChargeResult: null,
                stripeChargeError: 'No Stripe customer ID found for this customer',
                stripeCharged: false,
            };
        }

        const currency = feeResult.currency || 'GBP';

        try {
            const idempotencyKey = `noshow-${attemptType}-booking-${bookingData.id}-attempt-${attemptId}`;
            const stripePresentation = buildStripeChargePresentation({
                chargeType: 'no_show_fee',
                bookingId: bookingData.id,
                orderTrackId: stripeBooking.orderTrackId,
                amount: chargeAmount,
                currency,
                paymentType: stripeBooking.paymentType || 'card',
                customer: customerData,
                agent: {},
                zoneId: bookingData.zoneId,
                laundryShopId: stripeBooking.adminAssignedShopId,
                extra: {
                    attemptType,
                    attemptId,
                    policyApplied: feeResult.policyApplied || 'no_show_fee',
                },
            });

            const stripeChargeResult = await chargeOffSession(
                chargeAmount,
                customerData.stripeCustomerId,
                paymentMethodId,
                idempotencyKey,
                stripePresentation
            );

            console.log(
                `✅ No-show charge of ${chargeAmount} ${currency} for booking ${bookingData.id} (${attemptType} attempt ${attemptId})`
            );

            return {
                stripeChargeResult: {
                    id: stripeChargeResult.id,
                    status: stripeChargeResult.status,
                    amount: stripeChargeResult.amount,
                },
                stripeChargeError: null,
                stripeCharged: true,
            };
        } catch (chargeErr) {
            const message = chargeErr.message || String(chargeErr);
            console.error(
                `❌ Failed to charge no-show fee for booking ${bookingData.id}:`,
                message
            );
            return {
                stripeChargeResult: null,
                stripeChargeError: message,
                stripeCharged: false,
            };
        }
    }

    async resolveNoShowPolicy(bookingData) {
        return resolveNoShowPolicyForBooking({
            noShowPolicyId: bookingData.noShowPolicyId,
            zoneId: bookingData.zoneId,
        });
    }

    _resolveOrderValue(bookingData) {
        const orderAmount = parseFloat(bookingData.orderAmount) || 0;
        const subTotal = parseFloat(bookingData.subTotal) || 0;
        return orderAmount > 0 ? orderAmount : subTotal;
    }

    _calculateBaseFee(config, attemptType, orderValue) {
        if (!config) return { fee: 0, currency: 'USD' };

        if (attemptType === 'pickup' && !config.enableForPickup) {
            return { fee: 0, currency: config.currency || 'USD', disabled: true };
        }
        if (attemptType === 'delivery' && !config.enableForDelivery) {
            return { fee: 0, currency: config.currency || 'USD', disabled: true };
        }

        const currency = config.currency || 'USD';
        const feeType = config.feeType || 'absolute';
        let fee = 0;

        const pickupFee = parseFloat(config.pickupNoShowFee) || 0;
        const deliveryFee = parseFloat(
            config.useUnifiedFee ? config.pickupNoShowFee : config.deliveryNoShowFee
        ) || 0;
        const absoluteFee = attemptType === 'pickup' ? pickupFee : deliveryFee;

        if (feeType === 'absolute' || feeType === 'both') {
            fee += absoluteFee;
        }
        if (feeType === 'percentage' || feeType === 'both') {
            const pct = parseFloat(config.percentageFee) || 0;
            fee += (orderValue * pct) / 100;
        }

        return { fee: this._roundMoney(fee), currency };
    }

    async _countCustomerChargedNoShows(customerId, windowDays) {
        const since = moment().subtract(windowDays, 'days').toDate();
        return bookingAttempt.count({
            where: {
                status: 'failed',
                feeWaived: false,
                feeAmount: { [Op.gt]: 0 },
                createdAt: { [Op.gte]: since },
            },
            include: [
                {
                    model: booking,
                    as: 'booking',
                    required: true,
                    where: { customerId },
                    attributes: [],
                },
            ],
        });
    }

    async _countCustomerFailedAttempts(customerId, attemptType, windowDays) {
        const since = moment().subtract(windowDays, 'days').toDate();
        return bookingAttempt.count({
            where: {
                attemptType,
                status: 'failed',
                createdAt: { [Op.gte]: since },
            },
            include: [
                {
                    model: booking,
                    as: 'booking',
                    required: true,
                    where: { customerId },
                    attributes: [],
                },
            ],
        });
    }

    async calculateNoShowFee({
        bookingData,
        attemptType,
        driverLateMinutes = 0,
        policyRecord,
    }) {
        const config = policyRecord?.noShowConfig;
        const orderValue = this._resolveOrderValue(bookingData);
        const base = this._calculateBaseFee(config, attemptType, orderValue);

        if (base.disabled) {
            return {
                feeAmount: 0,
                currency: base.currency,
                feeWaived: true,
                feeWaiveReason: 'Policy disabled for this attempt type',
                policyApplied: 'disabled',
            };
        }

        let feeAmount = base.fee;
        let feeWaived = false;
        let feeWaiveReason = null;
        let policyApplied = 'no_show_fee';

        if (config && driverLateMinutes > (config.driverLateSLA || 0)) {
            feeAmount = 0;
            feeWaived = true;
            feeWaiveReason = `Driver late ${driverLateMinutes}m (SLA ${config.driverLateSLA}m)`;
            policyApplied = 'driver_late_waiver';
        }

        if (!feeWaived && config?.autoForgiveFirstNoShow) {
            const forgivePeriod = config.autoForgivePeriod || 30;
            const forgiveCount = config.autoForgiveCount || 1;
            const priorFails = await this._countCustomerFailedAttempts(
                bookingData.customerId,
                attemptType,
                forgivePeriod
            );
            if (priorFails < forgiveCount) {
                feeAmount = 0;
                feeWaived = true;
                feeWaiveReason = `Auto-forgive (${priorFails + 1}/${forgiveCount})`;
                policyApplied = 'auto_forgive';
            }
        }

        if (!feeWaived && config?.perCustomerCap) {
            const capWindow = config.capWindowDays || 90;
            const chargedCount = await this._countCustomerChargedNoShows(
                bookingData.customerId,
                capWindow
            );
            if (chargedCount >= config.perCustomerCap) {
                feeAmount = 0;
                feeWaived = true;
                feeWaiveReason = `Per-customer cap reached (${config.perCustomerCap} in ${capWindow}d)`;
                policyApplied = 'customer_cap';
            }
        }

        return {
            feeAmount: this._roundMoney(feeAmount),
            currency: base.currency,
            feeWaived,
            feeWaiveReason,
            policyApplied,
            orderValue,
        };
    }

    _graceState(arrivedAt, graceMinutes) {
        const arrived = moment(arrivedAt);
        const graceEnd = arrived.clone().add(graceMinutes || 0, 'minutes');
        const now = moment();
        const graceElapsed = now.isSameOrAfter(graceEnd);
        const graceSecondsRemaining = graceElapsed ? 0 : graceEnd.diff(now, 'seconds');
        return {
            graceMinutes,
            graceEndAt: graceEnd.toISOString(),
            graceElapsed,
            graceSecondsRemaining,
            canMarkFailed: graceElapsed,
        };
    }

    _unattendedOptions(config, bookingData, attemptType) {
        if (!config) return [];

        const options = [];
        if (attemptType === 'pickup') {
            if (config.pickupBagAtDoor && bookingData.driverInstructionOptions === 'Collect from Outside') {
                options.push({ method: 'bag_at_door', label: 'Bag at door' });
            }
            if (
                config.concierge &&
                PICKUP_INSTRUCTION_UNATTENDED.has(bookingData.driverInstructionOptions) &&
                bookingData.driverInstructionOptions !== 'Collect from Outside'
            ) {
                options.push({ method: 'concierge', label: 'Concierge / reception' });
            }
            if (config.locker) {
                options.push({ method: 'locker', label: 'Locker' });
            }
        } else {
            if (
                config.deliveryLeaveAtDoor &&
                bookingData.driverInstructionOptions1 === 'Leave at the door'
            ) {
                options.push({ method: 'bag_at_door', label: 'Leave at door' });
            }
            if (
                config.concierge &&
                bookingData.driverInstructionOptions1 === 'Deliver to the Reception/Porter'
            ) {
                options.push({ method: 'concierge', label: 'Concierge / reception' });
            }
            if (config.locker) {
                options.push({ method: 'locker', label: 'Locker' });
            }
        }

        return options;
    }

    async getOpenAttempt(bookingId, attemptType) {
        return bookingAttempt.findOne({
            where: {
                bookingId,
                attemptType,
                status: 'arrived',
            },
            order: [['id', 'DESC']],
        });
    }

    async completeOpenAttempt(bookingId, attemptType) {
        const normalizedType = this._normalizeAttemptType(attemptType);
        const openAttempt = await this.getOpenAttempt(bookingId, normalizedType);
        if (!openAttempt) return null;

        await openAttempt.update({
            status: 'completed',
            completedAt: new Date(),
            feeAmount: 0,
            feeWaived: true,
            feeWaiveReason: 'Successful completion',
        });
        return openAttempt;
    }

    async openAttempt({ bookingId, attemptType, driverId }) {
        const normalizedType = this._normalizeAttemptType(attemptType);
        const bookingData = await this._loadBooking(bookingId);

        const existing = await this.getOpenAttempt(bookingId, normalizedType);
        if (existing) return existing;

        const attemptNumber =
            normalizedType === 'pickup'
                ? (bookingData.pickupAttemptCount || 0) + 1
                : (bookingData.deliveryAttemptCount || 0) + 1;

        const policyRecord = await this.resolveNoShowPolicy(bookingData);
        if (policyRecord?.id && !bookingData.noShowPolicyId) {
            await attachNoShowPolicyOnBooking(bookingId, bookingData.zoneId);
        }

        return bookingAttempt.create({
            bookingId,
            attemptType: normalizedType,
            attemptNumber,
            status: 'arrived',
            arrivedAt: new Date(),
            driverId: driverId || bookingData.driverId || null,
            noShowPolicyId: policyRecord?.id || null,
            feeAmount: 0,
            feeCurrency: policyRecord?.noShowConfig?.currency || 'USD',
        });
    }

    async getAttemptOptions(bookingId, attemptType, driverCoords = {}) {
        const normalizedType = this._normalizeAttemptType(attemptType);
        const bookingData = await this._loadBooking(bookingId);
        const expectedStatus = this._expectedArrivedStatus(normalizedType);

        if (bookingData.bookingStatusId !== expectedStatus) {
            throw new ValidationError(
                `Booking must be in arrived status (${expectedStatus}) for ${normalizedType} attempt options`
            );
        }

        const openAttempt = await this.getOpenAttempt(bookingId, normalizedType);
        if (!openAttempt) {
            throw new ConflictError('No open attempt found. Mark Arrived first.');
        }

        const policyRecord = await this.resolveNoShowPolicy(bookingData);
        const config = policyRecord?.noShowConfig;
        const grace = this._graceState(openAttempt.arrivedAt, config?.graceMinutesOnSite || 0);
        const feePreview = await this.calculateNoShowFee({
            bookingData,
            attemptType: normalizedType,
            driverLateMinutes: 0,
            policyRecord,
        });

        let geofence;
        try {
            geofence = await getDriverGeofenceStatus({
                bookingId,
                leg: normalizedType,
                driverLat: driverCoords.driverLat,
                driverLng: driverCoords.driverLng,
                geofenceBypassToken: driverCoords.geofenceBypassToken,
            });
        } catch (geofenceErr) {
            console.warn(
                `[noShowEnforcement] geofence calc failed for booking ${bookingId}:`,
                geofenceErr.message
            );
            geofence = {
                requiredRadiusMeters: 100,
                distanceMeters: null,
                withinGeofence: false,
                gpsRequired: false,
            };
        }

        const withinGeofence = geofence.withinGeofence === true;

        return {
            bookingId,
            attemptType: normalizedType,
            attemptId: openAttempt.id,
            attemptNumber: openAttempt.attemptNumber,
            arrivedAt: openAttempt.arrivedAt,
            ...grace,
            withinGeofence: geofence.withinGeofence,
            distanceMeters: geofence.distanceMeters,
            requiredRadiusMeters: geofence.requiredRadiusMeters,
            gpsRequired: geofence.gpsRequired === true,
            geofenceBypassed: geofence.geofenceBypassed === true,
            canMarkFailed: grace.graceElapsed && withinGeofence,
            canMarkUnattended: withinGeofence,
            unattendedOptions: this._unattendedOptions(config, bookingData, normalizedType),
            requirePhoto: Boolean(config?.requirePhoto),
            maxPickupAttempts: bookingData.maxPickupAttempts || 3,
            pickupAttemptCount: bookingData.pickupAttemptCount || 0,
            deliveryAttemptCount: bookingData.deliveryAttemptCount || 0,
            feePreview: {
                amount: feePreview.feeAmount,
                currency: feePreview.currency,
                policyApplied: feePreview.policyApplied,
            },
            canComplete:
                normalizedType === 'pickup'
                    ? bookingData.bookingStatusId === PICKUP_ARRIVED_STATUS
                    : bookingData.bookingStatusId === DELIVERY_ARRIVED_STATUS,
        };
    }

    async _appendHistory(bookingId, statusId, date, time) {
        await bookingHistory.create({
            bookingId,
            bookingStatusId: statusId,
            date,
            time,
        });
    }

    async markAttemptFailed({
        bookingId,
        attemptType,
        reason,
        driverLateMinutes = 0,
        driverLat,
        driverLng,
        geofenceBypassToken,
        wallClock,
    }) {
        const normalizedType = this._normalizeAttemptType(attemptType);

        await assertDriverWithinCustomerRadius({
            bookingId,
            leg: normalizedType,
            driverLat,
            driverLng,
            geofenceBypassToken,
        });

        const bookingData = await this._loadBooking(bookingId);
        const expectedStatus = this._expectedArrivedStatus(normalizedType);

        if (bookingData.bookingStatusId !== expectedStatus) {
            throw new ValidationError(
                `Cannot mark ${normalizedType} failed from current booking status`
            );
        }

        const openAttempt = await this.getOpenAttempt(bookingId, normalizedType);
        if (!openAttempt) {
            throw new ConflictError('No open attempt found. Mark Arrived first.');
        }

        const policyRecord = await this.resolveNoShowPolicy(bookingData);
        const config = policyRecord?.noShowConfig;
        const grace = this._graceState(openAttempt.arrivedAt, config?.graceMinutesOnSite || 0);

        if (!grace.graceElapsed) {
            throw new ValidationError(
                `Grace period not elapsed. Wait ${grace.graceSecondsRemaining}s or ${config?.graceMinutesOnSite || 0} minutes from arrival.`
            );
        }

        const feeResult = await this.calculateNoShowFee({
            bookingData,
            attemptType: normalizedType,
            driverLateMinutes,
            policyRecord,
        });

        await openAttempt.update({
            status: 'failed',
            failedAt: new Date(),
            failureReason: reason || 'Customer not available',
            driverLateMinutes: driverLateMinutes || null,
            feeAmount: feeResult.feeAmount,
            feeCurrency: feeResult.currency,
            feeWaived: feeResult.feeWaived,
            feeWaiveReason: feeResult.feeWaiveReason,
            noShowPolicyId: policyRecord?.id || openAttempt.noShowPolicyId,
        });

        let stripeCharge = {
            stripeChargeResult: null,
            stripeChargeError: null,
            stripeCharged: false,
        };
        if (normalizedType === 'pickup') {
            stripeCharge = await this._attemptNoShowFeeCharge({
                bookingData,
                feeResult,
                attemptId: openAttempt.id,
                attemptType: normalizedType,
            });
        }

        const feeWithStripe = {
            ...feeResult,
            stripeCharged: stripeCharge.stripeCharged,
            stripeChargeError: stripeCharge.stripeChargeError,
            stripePaymentIntentId: stripeCharge.stripeChargeResult?.id || null,
        };

        const accrued = this._roundMoney(
            (parseFloat(bookingData.noShowFeeAccrued) || 0) + feeResult.feeAmount
        );

        const historyDate = wallClock?.date;
        const historyTime = wallClock?.time;

        if (normalizedType === 'pickup') {
            const newPickupCount = (bookingData.pickupAttemptCount || 0) + 1;
            const maxAttempts = bookingData.maxPickupAttempts || 3;

            if (newPickupCount >= maxAttempts) {
                await booking.update(
                    {
                        pickupAttemptCount: newPickupCount,
                        noShowFeeAccrued: accrued,
                        bookingStatusId: CANCELLED_STATUS,
                    },
                    { where: { id: bookingId } }
                );
                if (historyDate && historyTime) {
                    await this._appendHistory(bookingId, CANCELLED_STATUS, historyDate, historyTime);
                }

                sendNotification(
                    bookingData.customerId,
                    'Pickup attempts exhausted',
                    'Your order was cancelled after multiple missed pickup attempts.',
                    { bookingId, attemptType: 'pickup', feeAmount: feeResult.feeAmount }
                );

                return {
                    outcome: 'cancelled',
                    attemptId: openAttempt.id,
                    pickupAttemptCount: newPickupCount,
                    maxPickupAttempts: maxAttempts,
                    fee: feeWithStripe,
                    bookingStatusId: CANCELLED_STATUS,
                    message: 'Maximum pickup attempts reached. Booking cancelled.',
                };
            }

            await booking.update(
                {
                    pickupAttemptCount: newPickupCount,
                    noShowFeeAccrued: accrued,
                    bookingStatusId: AWAITING_COLLECTION_STATUS,
                },
                { where: { id: bookingId } }
            );
            if (historyDate && historyTime) {
                await this._appendHistory(
                    bookingId,
                    AWAITING_COLLECTION_STATUS,
                    historyDate,
                    historyTime
                );
            }

            sendNotification(
                bookingData.customerId,
                'Pickup missed — reschedule required',
                'Your driver could not complete pickup. Please reschedule your collection slot.',
                { bookingId, attemptType: 'pickup', feeAmount: feeResult.feeAmount }
            );

            return {
                outcome: 'reschedule_required',
                attemptId: openAttempt.id,
                pickupAttemptCount: newPickupCount,
                maxPickupAttempts: maxAttempts,
                fee: feeWithStripe,
                bookingStatusId: AWAITING_COLLECTION_STATUS,
                message: 'Pickup failed. Booking returned to Awaiting Collection for retry.',
            };
        }

        const deliveryFeeWithStripe = { ...feeResult };

        const newDeliveryCount = (bookingData.deliveryAttemptCount || 0) + 1;
        await booking.update(
            {
                deliveryAttemptCount: newDeliveryCount,
                noShowFeeAccrued: accrued,
                bookingStatusId: DELIVERY_FAILED_STATUS,
            },
            { where: { id: bookingId } }
        );
        if (historyDate && historyTime) {
            await this._appendHistory(bookingId, DELIVERY_FAILED_STATUS, historyDate, historyTime);
        }

        sendNotification(
            bookingData.customerId,
            'Delivery attempt failed',
            'Your driver could not complete delivery. Please reschedule your delivery slot.',
            { bookingId, attemptType: 'delivery', feeAmount: feeResult.feeAmount }
        );

        return {
            outcome: 'delivery_failed',
            attemptId: openAttempt.id,
            deliveryAttemptCount: newDeliveryCount,
            fee: deliveryFeeWithStripe,
            bookingStatusId: DELIVERY_FAILED_STATUS,
            message: 'Delivery failed. Customer must reschedule delivery.',
        };
    }

    async markAttemptUnattended({
        bookingId,
        attemptType,
        method,
        driverUserId,
        driverLat,
        driverLng,
        geofenceBypassToken,
        wallClock,
    }) {
        const normalizedType = this._normalizeAttemptType(attemptType);

        await assertDriverWithinCustomerRadius({
            bookingId,
            leg: normalizedType,
            driverLat,
            driverLng,
            geofenceBypassToken,
        });

        const bookingData = await this._loadBooking(bookingId);
        const expectedStatus = this._expectedArrivedStatus(normalizedType);

        if (bookingData.bookingStatusId !== expectedStatus) {
            throw new ValidationError(
                `Cannot complete unattended ${normalizedType} from current booking status`
            );
        }

        const openAttempt = await this.getOpenAttempt(bookingId, normalizedType);
        if (!openAttempt) {
            throw new ConflictError('No open attempt found. Mark Arrived first.');
        }

        const policyRecord = await this.resolveNoShowPolicy(bookingData);
        const config = policyRecord?.noShowConfig;
        const allowed = this._unattendedOptions(config, bookingData, normalizedType);
        const normalizedMethod = String(method || '').trim();

        if (!allowed.some((o) => o.method === normalizedMethod)) {
            throw new ValidationError('Unattended method not allowed by policy or customer instructions');
        }

        if (config?.requirePhoto) {
            const proofCount = await proofOfDeliveries.count({
                where: {
                    bookingId,
                    userId: driverUserId,
                    deliveryType: normalizedType === 'pickup' ? 'pickUp' : 'dropOff',
                },
            });
            if (proofCount < 1) {
                throw new ValidationError('Photo proof is required before unattended completion');
            }
        }

        await openAttempt.update({
            status: 'unattended',
            completedAt: new Date(),
            unattendedMethod: normalizedMethod,
            feeAmount: 0,
            feeWaived: true,
            feeWaiveReason: 'Unattended completion',
        });

        const historyDate = wallClock?.date;
        const historyTime = wallClock?.time;
        const nextStatus =
            normalizedType === 'pickup' ? PICKUP_SUCCESS_STATUS : 17;

        await booking.update(
            { bookingStatusId: nextStatus },
            { where: { id: bookingId } }
        );

        if (historyDate && historyTime) {
            if (normalizedType === 'pickup') {
                await bookingHistory.bulkCreate([
                    {
                        bookingId,
                        bookingStatusId: 6,
                        date: historyDate,
                        time: historyTime,
                    },
                    {
                        bookingId,
                        bookingStatusId: PICKUP_SUCCESS_STATUS,
                        date: historyDate,
                        time: historyTime,
                    },
                ]);
            } else {
                await this._appendHistory(bookingId, nextStatus, historyDate, historyTime);
            }
        }

        sendNotification(
            bookingData.customerId,
            normalizedType === 'pickup' ? 'Pickup completed (unattended)' : 'Delivery completed (unattended)',
            normalizedType === 'pickup'
                ? 'Your laundry was collected as per your instructions.'
                : 'Your laundry was delivered as per your instructions.',
            { bookingId, attemptType: normalizedType, method: normalizedMethod }
        );

        return {
            outcome: 'unattended_success',
            attemptId: openAttempt.id,
            bookingStatusId: nextStatus,
            method: normalizedMethod,
        };
    }

    _normalizeDatePart(dateValue) {
        if (!dateValue) return null;
        if (typeof dateValue === 'string' && dateValue.length >= 10) {
            return dateValue.slice(0, 10);
        }
        if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
            return moment.utc(dateValue).format('YYYY-MM-DD');
        }
        return String(dateValue).slice(0, 10);
    }

    _normalizeTimePart(timeValue) {
        if (!timeValue) return null;
        const raw = String(timeValue).trim();
        if (/^\d{1,2}:\d{2}:\d{2}$/.test(raw)) return raw;
        if (/^\d{1,2}:\d{2}$/.test(raw)) return `${raw}:00`;
        return raw;
    }

    async rescheduleAfterFail({ bookingId, attemptType, schedule, wallClock }) {
        const normalizedType = this._normalizeAttemptType(attemptType);
        const bookingData = await this._loadBooking(bookingId);

        if (normalizedType === 'pickup') {
            if (bookingData.bookingStatusId !== AWAITING_COLLECTION_STATUS) {
                throw new ValidationError(
                    'Pickup can only be rescheduled when booking is Awaiting Collection (status 3)'
                );
            }

            const collectionDate = this._normalizeDatePart(schedule.collectionDate);
            const collectionTimeFrom = this._normalizeTimePart(schedule.collectionTimeFrom);
            const collectionTimeTo = this._normalizeTimePart(schedule.collectionTimeTo);
            const deliveryDate = this._normalizeDatePart(schedule.deliveryDate);
            const deliveryTimeFrom = this._normalizeTimePart(schedule.deliveryTimeFrom);
            const deliveryTimeTo = this._normalizeTimePart(schedule.deliveryTimeTo);

            if (!collectionDate || !collectionTimeFrom || !collectionTimeTo) {
                throw new ValidationError('collectionDate, collectionTimeFrom and collectionTimeTo are required');
            }
            if (!deliveryDate || !deliveryTimeFrom || !deliveryTimeTo) {
                throw new ValidationError('deliveryDate, deliveryTimeFrom and deliveryTimeTo are required');
            }

            await booking.update(
                {
                    collectionDate,
                    collectionTimeFrom,
                    collectionTimeTo,
                    deliveryDate,
                    deliveryTimeFrom,
                    deliveryTimeTo,
                    bookingStatusId: AWAITING_COLLECTION_STATUS,
                },
                { where: { id: bookingId } }
            );

            if (wallClock?.date && wallClock?.time) {
                await this._appendHistory(
                    bookingId,
                    AWAITING_COLLECTION_STATUS,
                    wallClock.date,
                    wallClock.time
                );
            }

            sendNotification(
                bookingData.customerId,
                'Pickup rescheduled',
                'Your pickup slot has been updated after a missed attempt.',
                { bookingId }
            );

            return {
                outcome: 'pickup_rescheduled',
                bookingStatusId: AWAITING_COLLECTION_STATUS,
                schedule: {
                    collectionDate,
                    collectionTimeFrom,
                    collectionTimeTo,
                    deliveryDate,
                    deliveryTimeFrom,
                    deliveryTimeTo,
                },
            };
        }

        if (bookingData.bookingStatusId !== DELIVERY_FAILED_STATUS) {
            throw new ValidationError(
                'Delivery can only be rescheduled when booking is Delivery Failed (status 15)'
            );
        }

        const deliveryDate = this._normalizeDatePart(schedule.deliveryDate);
        const deliveryTimeFrom = this._normalizeTimePart(schedule.deliveryTimeFrom);
        const deliveryTimeTo = this._normalizeTimePart(schedule.deliveryTimeTo);

        if (!deliveryDate || !deliveryTimeFrom || !deliveryTimeTo) {
            throw new ValidationError('deliveryDate, deliveryTimeFrom and deliveryTimeTo are required');
        }

        await booking.update(
            {
                deliveryDate,
                deliveryTimeFrom,
                deliveryTimeTo,
                bookingStatusId: READY_FOR_DELIVERY_STATUS,
            },
            { where: { id: bookingId } }
        );

        if (wallClock?.date && wallClock?.time) {
            await this._appendHistory(
                bookingId,
                READY_FOR_DELIVERY_STATUS,
                wallClock.date,
                wallClock.time
            );
        }

        sendNotification(
            bookingData.customerId,
            'Delivery rescheduled',
            'Your delivery slot has been updated after a failed attempt.',
            { bookingId }
        );

        return {
            outcome: 'delivery_rescheduled',
            bookingStatusId: READY_FOR_DELIVERY_STATUS,
            schedule: { deliveryDate, deliveryTimeFrom, deliveryTimeTo },
        };
    }
}

module.exports = new NoShowEnforcementService();

'use strict';

const {
    formatOrderExpireTimeForApi,
    getAcceptWindowMinutesRemaining,
} = require('./bookingTimeZone');
const { getAcceptWindowAnchor } = require('./bookingAgentWindow');

function isoDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Canonical payload for an unassigned marketplace offer.
 *
 * `laundryShopId` is deliberately null: it is the booking's assigned-shop FK,
 * not the shop currently receiving this offer. `offeredToShopId` carries the
 * recipient context without making clients treat the booking as assigned.
 */
function buildNewBookingOfferPayload({
    bookingDetails,
    collectionDate,
    collectionTimeTo,
    collectionTimeFrom,
    deliveryDate,
    deliveryTimeTo,
    deliveryTimeFrom,
    timeZone,
    offeredToShopId,
    pickupDistanceKm = null,
    deliveryDistanceKm = null,
    isPreferredShopOffer = false,
}) {
    const customer = bookingDetails?.customer || {};
    const expireClock = formatOrderExpireTimeForApi(
        bookingDetails?.orderExpireTime
    );

    return {
        id: bookingDetails?.id,
        orderTrackId: bookingDetails?.orderTrackId,
        bookingStatusId: Number(bookingDetails?.bookingStatusId || 1),
        collectionDate: isoDate(collectionDate),
        collectionTimeTo,
        collectionTimeFrom,
        deliveryDate: isoDate(deliveryDate),
        deliveryTimeTo,
        deliveryTimeFrom,
        driverInstructionOptions:
            bookingDetails?.driverInstructionOptions || null,
        driverInstructionOptions1:
            bookingDetails?.driverInstructionOptions1 || null,
        driverInstruction: bookingDetails?.driverInstruction || null,
        paymentConfirmed: bookingDetails?.paymentConfirmed || false,
        partialPayment: bookingDetails?.partialPayment || false,
        totalItems: bookingDetails?.totalItems || 0,
        orderAmount: bookingDetails?.billingDetail?.total || 0,
        frequency: bookingDetails?.frequency || 'Just Once',
        createdAt: bookingDetails?.createdAt,
        agentVisibleAt: bookingDetails?.agentVisibleAt || null,
        orderExpireTime: expireClock,
        acceptWindowMinutes: getAcceptWindowMinutesRemaining(
            getAcceptWindowAnchor(bookingDetails),
            bookingDetails?.orderExpireTime,
            timeZone
        ),
        orderExpireTimeClock: expireClock,
        pickupAddresId: bookingDetails?.pickupAddresId || null,
        dropOffAddressId: bookingDetails?.dropOffAddressId || null,
        laundryShopId: null,
        offeredToShopId: offeredToShopId || null,
        customerId: customer.id,
        pickupAddress: bookingDetails?.pickupAddress || {},
        dropOffAddress: bookingDetails?.dropOffAddress || {},
        pickupDistanceKm,
        deliveryDistanceKm,
        isNearestPickup: false,
        isNearestDelivery: false,
        customer: {
            id: customer.id,
            firstName: customer.firstName,
            lastName: customer.lastName,
            email: customer.email,
            userTypeId: customer.userTypeId || 2,
            image: customer.image || null,
            phoneNum: customer.phoneNum,
        },
        zone: bookingDetails?.zone || {},
        isPreferredShopOffer,
    };
}

module.exports = { buildNewBookingOfferPayload };

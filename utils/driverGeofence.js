const geolib = require('geolib');
const { booking, addressDb } = require('../models');
const { ValidationError, NotFoundError } = require('../middlewares/universalErrorHandler');

/** Default radius (meters) for Arrived / no-show / unattended actions. */
const ARRIVAL_RADIUS_METERS = 100;

function parseDriverCoordinates(driverLat, driverLng) {
    if (driverLat == null || driverLat === '' || driverLng == null || driverLng === '') {
        throw new ValidationError('driverLat and driverLng are required');
    }

    const lat = parseFloat(driverLat);
    const lng = parseFloat(driverLng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new ValidationError('driverLat and driverLng must be valid numbers');
    }
    if (lat < -90 || lat > 90) {
        throw new ValidationError('driverLat must be between -90 and 90');
    }
    if (lng < -180 || lng > 180) {
        throw new ValidationError('driverLng must be between -180 and 180');
    }

    return { latitude: lat, longitude: lng };
}

function normalizeLeg(leg) {
    const normalized = String(leg || '').trim().toLowerCase();
    if (normalized === 'pickup' || normalized === 'delivery') return normalized;
    throw new ValidationError('leg must be pickup or delivery');
}

async function loadCustomerCoordinates(bookingId, leg) {
    const normalizedLeg = normalizeLeg(leg);
    const addressField = normalizedLeg === 'pickup' ? 'pickupAddresId' : 'dropOffAddressId';

    const bookingRow = await booking.findOne({
        where: { id: bookingId },
        attributes: ['id', 'pickupAddresId', 'dropOffAddressId'],
    });

    if (!bookingRow) {
        throw new NotFoundError(`Booking ${bookingId} not found`);
    }

    const addressId = bookingRow[addressField];
    if (!addressId) {
        throw new ValidationError(
            `Customer ${normalizedLeg} address is not set for this booking`
        );
    }

    const addressRow = await addressDb.findOne({
        where: { id: addressId },
        attributes: ['id', 'lat', 'lng'],
    });

    if (!addressRow) {
        throw new NotFoundError(`Customer ${normalizedLeg} address not found`);
    }

    const lat = parseFloat(addressRow.lat);
    const lng = parseFloat(addressRow.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new ValidationError(
            `Customer ${normalizedLeg} address is missing valid coordinates`
        );
    }

    return {
        latitude: lat,
        longitude: lng,
        addressId,
    };
}

function distanceMetersBetween(from, to) {
    return geolib.getDistance(from, to);
}

/**
 * Returns geofence evaluation without throwing when coords are optional.
 */
async function getDriverGeofenceStatus({
    bookingId,
    leg,
    driverLat,
    driverLng,
    radiusMeters = ARRIVAL_RADIUS_METERS,
}) {
    if (driverLat == null || driverLat === '' || driverLng == null || driverLng === '') {
        return {
            requiredRadiusMeters: radiusMeters,
            distanceMeters: null,
            withinGeofence: null,
        };
    }

    const driverPoint = parseDriverCoordinates(driverLat, driverLng);
    const customerPoint = await loadCustomerCoordinates(bookingId, leg);
    const distanceMeters = distanceMetersBetween(driverPoint, customerPoint);

    return {
        requiredRadiusMeters: radiusMeters,
        distanceMeters,
        withinGeofence: distanceMeters <= radiusMeters,
        customerLat: customerPoint.latitude,
        customerLng: customerPoint.longitude,
    };
}

/**
 * Throws ValidationError if driver is outside the allowed radius.
 */
async function assertDriverWithinCustomerRadius({
    bookingId,
    leg,
    driverLat,
    driverLng,
    radiusMeters = ARRIVAL_RADIUS_METERS,
}) {
    const status = await getDriverGeofenceStatus({
        bookingId,
        leg,
        driverLat,
        driverLng,
        radiusMeters,
    });

    if (!status.withinGeofence) {
        throw new ValidationError(
            `You must be within ${radiusMeters}m of the customer location`,
            {
                distanceMeters: status.distanceMeters,
                requiredRadiusMeters: status.requiredRadiusMeters,
                withinGeofence: false,
            }
        );
    }

    return status;
}

module.exports = {
    ARRIVAL_RADIUS_METERS,
    parseDriverCoordinates,
    getDriverGeofenceStatus,
    assertDriverWithinCustomerRadius,
};

const geolib = require('geolib');
const { addressDb } = require('../models');
const { ValidationError, NotFoundError, UniversalHttpError } = require('../middlewares/universalErrorHandler');
const { StatusCodes } = require('http-status-codes');
const {
    DEFAULT_ARRIVAL_RADIUS_METERS,
    resolveArrivalRadiusForBookingId,
    loadBookingForAttempts,
} = require('./safeNoShowPolicyQuery');

class GeofenceOutOfRangeError extends UniversalHttpError {
    constructor(requiredRadiusMeters, distanceMeters) {
        super(
            `You must be within ${requiredRadiusMeters}m of the customer address`,
            StatusCodes.BAD_REQUEST,
            {
                distanceMeters,
                requiredRadiusMeters,
                withinGeofence: false,
            }
        );
        this.name = 'GeofenceOutOfRangeError';
        this.errorCode = 'GEOFENCE_OUT_OF_RANGE';
    }
}

function parseDriverCoordinates(driverLat, driverLng, { required = true } = {}) {
    const missing =
        driverLat == null || driverLat === '' || driverLng == null || driverLng === '';

    if (missing) {
        if (required) {
            throw new ValidationError('driverLat and driverLng are required');
        }
        return null;
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

    const bookingRow = await loadBookingForAttempts(bookingId, ['pickupAddresId', 'dropOffAddressId']);
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
 * Geofence status for attempt-options UI (never throws for missing GPS).
 */
async function getDriverGeofenceStatus({
    bookingId,
    leg,
    driverLat,
    driverLng,
    radiusMeters,
}) {
    let requiredRadiusMeters = DEFAULT_ARRIVAL_RADIUS_METERS;
    try {
        requiredRadiusMeters =
            radiusMeters != null
                ? Math.max(1, parseInt(radiusMeters, 10) || DEFAULT_ARRIVAL_RADIUS_METERS)
                : await resolveArrivalRadiusForBookingId(bookingId);
    } catch (err) {
        console.warn('[driverGeofence] radius resolve failed, using default:', err.message);
    }

    const driverPoint = parseDriverCoordinates(driverLat, driverLng, { required: false });

    if (!driverPoint) {
        return {
            requiredRadiusMeters,
            distanceMeters: null,
            withinGeofence: false,
            gpsRequired: true,
        };
    }

    const customerPoint = await loadCustomerCoordinates(bookingId, leg);
    const distanceMeters = distanceMetersBetween(driverPoint, customerPoint);

    return {
        requiredRadiusMeters,
        distanceMeters,
        withinGeofence: distanceMeters <= requiredRadiusMeters,
        gpsRequired: false,
        customerLat: customerPoint.latitude,
        customerLng: customerPoint.longitude,
    };
}

/**
 * Server-side enforce — throws GeofenceOutOfRangeError or ValidationError (missing GPS).
 */
async function assertDriverWithinCustomerRadius({
    bookingId,
    leg,
    driverLat,
    driverLng,
    radiusMeters,
}) {
    let requiredRadiusMeters = DEFAULT_ARRIVAL_RADIUS_METERS;
    try {
        requiredRadiusMeters =
            radiusMeters != null
                ? Math.max(1, parseInt(radiusMeters, 10) || DEFAULT_ARRIVAL_RADIUS_METERS)
                : await resolveArrivalRadiusForBookingId(bookingId);
    } catch (err) {
        console.warn('[driverGeofence] radius resolve failed, using default:', err.message);
    }

    const driverPoint = parseDriverCoordinates(driverLat, driverLng, { required: true });
    const customerPoint = await loadCustomerCoordinates(bookingId, leg);
    const distanceMeters = distanceMetersBetween(driverPoint, customerPoint);

    if (distanceMeters > requiredRadiusMeters) {
        throw new GeofenceOutOfRangeError(requiredRadiusMeters, distanceMeters);
    }

    return {
        requiredRadiusMeters,
        distanceMeters,
        withinGeofence: true,
        gpsRequired: false,
    };
}

module.exports = {
    DEFAULT_ARRIVAL_RADIUS_METERS,
    GeofenceOutOfRangeError,
    parseDriverCoordinates,
    getDriverGeofenceStatus,
    assertDriverWithinCustomerRadius,
    ARRIVAL_RADIUS_METERS: DEFAULT_ARRIVAL_RADIUS_METERS,
};

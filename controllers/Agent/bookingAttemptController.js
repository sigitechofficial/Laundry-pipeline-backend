const ResponseHelper = require('../../utils/responseHelper');
const noShowEnforcementService = require('../../services/Agent/noShowEnforcementService');
const { ValidationError } = require('../../middlewares/universalErrorHandler');
const { bookingWallClockNow } = require('../../utils/countryTimeZone');

/**
 * GET /api/agent/booking/:bookingId/attempt-options?type=pickup|delivery
 */
exports.getAttemptOptions = async (req, res) => {
    const { bookingId } = req.params;
    const { type } = req.query;

    if (!type) {
        throw new ValidationError('Query param type is required (pickup or delivery)');
    }

    const result = await noShowEnforcementService.getAttemptOptions(bookingId, type, {
        driverLat: req.query.driverLat,
        driverLng: req.query.driverLng,
        geofenceBypassToken: req.query.geofenceBypassToken,
    });
    return ResponseHelper.success(res, 'Attempt options fetched', result);
};

/**
 * POST /api/agent/booking/:bookingId/attempt/fail
 */
exports.markAttemptFailed = async (req, res) => {
    const { bookingId } = req.params;
    const {
        type,
        reason,
        reasonId,
        reasonNote,
        driverLateMinutes,
        driverLat,
        driverLng,
        geofenceBypassToken,
        compliance,
    } = req.body;

    if (!type) {
        throw new ValidationError('type is required (pickup or delivery)');
    }
    if (reasonId == null || reasonId === '') {
        throw new ValidationError('reasonId is required');
    }

    const result = await noShowEnforcementService.markAttemptFailed({
        bookingId,
        attemptType: type,
        reason,
        reasonId,
        reasonNote,
        driverLateMinutes: driverLateMinutes != null ? Number(driverLateMinutes) : 0,
        driverLat,
        driverLng,
        geofenceBypassToken,
        // History stamps on the booking's operational clock, not the device's.
        wallClock: await bookingWallClockNow(bookingId),
        compliance,
        actorUserId: req.actorUserId || req.user?.id,
    });

    return ResponseHelper.success(res, result.message || 'Attempt marked as failed', result);
};

/**
 * POST /api/agent/booking/:bookingId/attempt/reschedule
 */
exports.rescheduleAfterFail = async (req, res) => {
    const { bookingId } = req.params;
    const { type, collectionDate, collectionTimeFrom, collectionTimeTo, deliveryDate, deliveryTimeFrom, deliveryTimeTo } =
        req.body;

    if (!type) {
        throw new ValidationError('type is required (pickup or delivery)');
    }

    const result = await noShowEnforcementService.rescheduleAfterFail({
        bookingId,
        attemptType: type,
        schedule: {
            collectionDate,
            collectionTimeFrom,
            collectionTimeTo,
            deliveryDate,
            deliveryTimeFrom,
            deliveryTimeTo,
        },
        // History stamps on the booking's operational clock, not the device's.
        wallClock: await bookingWallClockNow(bookingId),
    });

    return ResponseHelper.success(res, 'Schedule updated after failed attempt', result);
};

/**
 * POST /api/agent/booking/:bookingId/attempt/unattended
 */
exports.markAttemptUnattended = async (req, res) => {
    const { bookingId } = req.params;
    const { type, method, driverLat, driverLng, geofenceBypassToken } = req.body;

    if (!type) {
        throw new ValidationError('type is required (pickup or delivery)');
    }
    if (!method) {
        throw new ValidationError('method is required (bag_at_door, concierge, locker)');
    }

    const result = await noShowEnforcementService.markAttemptUnattended({
        bookingId,
        attemptType: type,
        method,
        driverUserId: req.user?.id,
        driverLat,
        driverLng,
        geofenceBypassToken,
        // History stamps on the booking's operational clock, not the device's.
        wallClock: await bookingWallClockNow(bookingId),
    });

    return ResponseHelper.success(res, 'Unattended completion recorded', result);
};

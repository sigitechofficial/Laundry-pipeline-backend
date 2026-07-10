const ResponseHelper = require('../../utils/responseHelper');
const noShowEnforcementService = require('../../services/Agent/noShowEnforcementService');
const { ValidationError } = require('../../middlewares/universalErrorHandler');

function agentWallClockDateTime(timeZone, clientTimeZone) {
    const tz =
        (timeZone && String(timeZone).trim()) ||
        (clientTimeZone && String(clientTimeZone).trim()) ||
        'Europe/London';
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        time: `${get('hour')}:${get('minute')}:${get('second')}`,
    };
}

/**
 * GET /api/agent/booking/:bookingId/attempt-options?type=pickup|delivery
 */
exports.getAttemptOptions = async (req, res) => {
    const { bookingId } = req.params;
    const { type } = req.query;

    if (!type) {
        throw new ValidationError('Query param type is required (pickup or delivery)');
    }

    const result = await noShowEnforcementService.getAttemptOptions(bookingId, type);
    return ResponseHelper.success(res, 'Attempt options fetched', result);
};

/**
 * POST /api/agent/booking/:bookingId/attempt/fail
 */
exports.markAttemptFailed = async (req, res) => {
    const { bookingId } = req.params;
    const { type, reason, driverLateMinutes } = req.body;

    if (!type) {
        throw new ValidationError('type is required (pickup or delivery)');
    }

    const result = await noShowEnforcementService.markAttemptFailed({
        bookingId,
        attemptType: type,
        reason,
        driverLateMinutes: driverLateMinutes != null ? Number(driverLateMinutes) : 0,
        wallClock: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone),
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
        wallClock: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone),
    });

    return ResponseHelper.success(res, 'Schedule updated after failed attempt', result);
};

/**
 * POST /api/agent/booking/:bookingId/attempt/unattended
 */
exports.markAttemptUnattended = async (req, res) => {
    const { bookingId } = req.params;
    const { type, method } = req.body;

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
        wallClock: agentWallClockDateTime(req.body?.timeZone, req.body?.clientTimeZone),
    });

    return ResponseHelper.success(res, 'Unattended completion recorded', result);
};

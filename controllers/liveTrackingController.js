/**
 * Customer + Agent live-tracking bootstrap endpoints.
 */

const { booking } = require('../models');
const ResponseHelper = require('../utils/responseHelper');
const {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  UniversalHttpError,
} = require('../middlewares/universalErrorHandler');
const {
  LIVE_TRACKING_ROOT,
  isDeliveryTrackableStatus,
  isLiveTrackableStatus,
  legForStatus,
  getLiveTrackingSnapshot,
  openLiveTrackingSession,
} = require('../utils/liveTrackingRtdb');
const { createLiveTrackingCustomToken } = require('../utils/liveTrackingAuth');
const { getFirebaseDatabaseUrl } = require('../utils/notification');
const { StatusCodes } = require('http-status-codes');

function assignedDriverIdForTracking(bookingRow, statusId) {
  if (isDeliveryTrackableStatus(statusId)) {
    return bookingRow.deliveryDriverId || bookingRow.driverId;
  }
  return bookingRow.driverId;
}

function isWithinReadGrace(snapshot) {
  const endedAt = snapshot?.meta?.endedAt;
  if (!endedAt) return false;
  return Date.now() < Number(endedAt) + 5 * 60 * 1000;
}

async function issueTrackingToken(role, appUserId) {
  try {
    return await createLiveTrackingCustomToken(role, appUserId);
  } catch (err) {
    if (err.code === 'FIREBASE_NOT_CONFIGURED' || err.code === 'INVALID_USER') {
      throw new UniversalHttpError(
        err.message || 'Live tracking is temporarily unavailable',
        StatusCodes.SERVICE_UNAVAILABLE,
        { code: err.code || 'FIREBASE_ERROR' }
      );
    }
    throw err;
  }
}

/**
 * GET /customer/live-tracking/:bookingId
 * Returns session bootstrap for the customer map (token + destination + enabled).
 */
exports.getCustomerLiveTracking = async (req, res) => {
  const bookingId = parseInt(req.params.bookingId, 10);
  const customerId = req.user?.id;

  if (!Number.isFinite(bookingId)) {
    throw new ValidationError('bookingId is required');
  }

  const bookingRow = await booking.findByPk(bookingId, {
    attributes: [
      'id',
      'customerId',
      'driverId',
      'deliveryDriverId',
      'bookingStatusId',
      'pickupAddresId',
      'dropOffAddressId',
      'orderTrackId',
    ],
  });

  if (!bookingRow) {
    throw new NotFoundError(`Booking ${bookingId} not found`);
  }

  if (Number(bookingRow.customerId) !== Number(customerId)) {
    throw new ForbiddenError('You do not have access to this booking');
  }

  const statusId = Number(bookingRow.bookingStatusId);
  const enabled = isLiveTrackableStatus(statusId);
  const leg = legForStatus(statusId);

  let snapshot = await getLiveTrackingSnapshot(bookingId);
  if (enabled && (!snapshot || !snapshot.meta?.active)) {
    await openLiveTrackingSession({
      bookingId,
      leg,
      bookingRow,
    });
    snapshot = await getLiveTrackingSnapshot(bookingId);
  }

  const graceReadable = isWithinReadGrace(snapshot);
  const canSubscribe =
    enabled || Boolean(snapshot?.meta?.active) || graceReadable;

  let auth = null;
  if (canSubscribe) {
    auth = await issueTrackingToken('customer', customerId);
  }

  return ResponseHelper.success(res, 'Live tracking session', {
    enabled,
    bookingId,
    orderTrackId: bookingRow.orderTrackId,
    bookingStatusId: statusId,
    leg: enabled ? leg : snapshot?.meta?.leg || null,
    rtdbPath: `${LIVE_TRACKING_ROOT}/${bookingId}`,
    databaseURL: getFirebaseDatabaseUrl(),
    firebaseAuthToken: auth?.token || null,
    firebaseUid: auth?.uid || null,
    destination: snapshot?.meta?.destination || null,
    agent: snapshot?.meta?.agent || null,
    active: Boolean(snapshot?.meta?.active),
    location: snapshot?.location || null,
    route: snapshot?.route || null,
    reason: enabled
      ? null
      : statusId === 5 || statusId === 14
        ? 'driver_arrived'
        : statusId === 19
          ? 'cancelled'
          : statusId === 18 || statusId === 24
            ? 'on_hold'
            : statusId === 15
              ? 'delivery_failed'
              : 'not_in_transit',
  });
};

/**
 * GET /agent/live-tracking/:bookingId
 * Returns publish bootstrap for the assigned agent (token + path).
 */
exports.getAgentLiveTracking = async (req, res) => {
  const bookingId = parseInt(req.params.bookingId, 10);
  const agentId = req.user?.id;

  if (!Number.isFinite(bookingId)) {
    throw new ValidationError('bookingId is required');
  }

  const bookingRow = await booking.findByPk(bookingId, {
    attributes: [
      'id',
      'customerId',
      'driverId',
      'deliveryDriverId',
      'bookingStatusId',
      'pickupAddresId',
      'dropOffAddressId',
      'orderTrackId',
    ],
  });

  if (!bookingRow) {
    throw new NotFoundError(`Booking ${bookingId} not found`);
  }

  const statusId = Number(bookingRow.bookingStatusId);
  const enabled = isLiveTrackableStatus(statusId);
  const assignedDriverId = assignedDriverIdForTracking(bookingRow, statusId);

  if (!assignedDriverId) {
    throw new ForbiddenError('No driver is assigned to this booking');
  }

  if (Number(assignedDriverId) !== Number(agentId)) {
    throw new ForbiddenError('You are not the assigned driver for this booking');
  }

  const leg = legForStatus(statusId);

  if (enabled) {
    await openLiveTrackingSession({
      bookingId,
      leg,
      agentId,
      bookingRow,
    });
  }

  let auth = null;
  if (enabled) {
    auth = await issueTrackingToken('agent', agentId);
  }

  const snapshot = await getLiveTrackingSnapshot(bookingId);

  return ResponseHelper.success(res, 'Live tracking publisher session', {
    enabled,
    bookingId,
    orderTrackId: bookingRow.orderTrackId,
    bookingStatusId: statusId,
    leg: enabled ? leg : null,
    rtdbPath: `${LIVE_TRACKING_ROOT}/${bookingId}`,
    databaseURL: getFirebaseDatabaseUrl(),
    firebaseAuthToken: auth?.token || null,
    firebaseUid: auth?.uid || null,
    destination: snapshot?.meta?.destination || null,
    publishIntervalMs: 3000,
    distanceFilterMeters: 20,
    reason: enabled ? null : 'not_in_transit',
  });
};

/**
 * POST /agent/live-tracking/:bookingId/demo-stream
 * Body: { loop?: boolean, intervalMs?: number, steps?: number }
 * Starts an in-process fake GPS stream for customer Live map QA.
 */
exports.startDemoLiveTrackingStream = async (req, res) => {
  const bookingId = parseInt(req.params.bookingId, 10);
  const agentId = req.user?.id;

  if (!Number.isFinite(bookingId)) {
    throw new ValidationError('bookingId is required');
  }

  const bookingRow = await booking.findByPk(bookingId, {
    attributes: [
      'id',
      'customerId',
      'driverId',
      'deliveryDriverId',
      'bookingStatusId',
      'pickupAddresId',
      'dropOffAddressId',
      'orderTrackId',
    ],
  });

  if (!bookingRow) {
    throw new NotFoundError(`Booking ${bookingId} not found`);
  }

  const statusId = Number(bookingRow.bookingStatusId);
  const assignedDriverId = assignedDriverIdForTracking(bookingRow, statusId);

  if (!assignedDriverId || Number(assignedDriverId) !== Number(agentId)) {
    throw new ForbiddenError('You are not the assigned driver for this booking');
  }

  const {
    startDemoStream,
  } = require('../services/demoLiveTrackingStreamService');

  const loop = req.body?.loop !== false && req.body?.loop !== 'false';
  const intervalMs = Math.max(
    500,
    parseInt(req.body?.intervalMs, 10) || 2000
  );
  const steps = Math.max(5, parseInt(req.body?.steps, 10) || 40);

  try {
    const result = await startDemoStream({
      bookingId,
      bookingRow,
      agentId,
      intervalMs,
      steps,
      loop,
    });
    return ResponseHelper.success(res, 'Demo live tracking stream started', result);
  } catch (err) {
    if (err.code === 'NOT_IN_TRANSIT') {
      throw new ValidationError(err.message);
    }
    throw new UniversalHttpError(
      err.message || 'Could not start demo stream',
      StatusCodes.SERVICE_UNAVAILABLE,
      { code: err.code || 'DEMO_STREAM_FAILED' }
    );
  }
};

/**
 * DELETE /agent/live-tracking/:bookingId/demo-stream
 */
exports.stopDemoLiveTrackingStream = async (req, res) => {
  const bookingId = parseInt(req.params.bookingId, 10);
  const agentId = req.user?.id;

  if (!Number.isFinite(bookingId)) {
    throw new ValidationError('bookingId is required');
  }

  const bookingRow = await booking.findByPk(bookingId, {
    attributes: ['id', 'driverId', 'deliveryDriverId', 'bookingStatusId'],
  });
  if (!bookingRow) {
    throw new NotFoundError(`Booking ${bookingId} not found`);
  }

  const statusId = Number(bookingRow.bookingStatusId);
  const assignedDriverId = assignedDriverIdForTracking(bookingRow, statusId);

  if (!assignedDriverId || Number(assignedDriverId) !== Number(agentId)) {
    throw new ForbiddenError('You are not the assigned driver for this booking');
  }

  const {
    stopDemoStream,
    isDemoStreamRunning,
  } = require('../services/demoLiveTrackingStreamService');

  const wasRunning = isDemoStreamRunning(bookingId);
  stopDemoStream(bookingId);

  return ResponseHelper.success(res, 'Demo live tracking stream stopped', {
    bookingId,
    stopped: wasRunning,
  });
};

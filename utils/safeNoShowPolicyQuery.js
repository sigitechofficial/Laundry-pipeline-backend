const { Op } = require('sequelize');
const { policy, noShowPolicyConfig, booking } = require('../models');
const activePoliciesService = require('../services/Admin/activePoliciesService');

const DEFAULT_ARRIVAL_RADIUS_METERS = 100;

/** Explicit attrs — avoids Sequelize selecting missing DB columns. */
const NO_SHOW_CONFIG_ATTRS_BASE = [
    'id',
    'policyId',
    'enableForPickup',
    'enableForDelivery',
    'useUnifiedFee',
    'feeType',
    'currency',
    'pickupNoShowFee',
    'deliveryNoShowFee',
    'storageFeePerDay',
    'percentageFee',
    'graceMinutesOnSite',
    'driverLateSLA',
    'callsMinutes',
    'smsMinutes',
    'pickupBagAtDoor',
    'deliveryLeaveAtDoor',
    'concierge',
    'locker',
    'requirePhoto',
    'waiverType',
    'absoluteWaiverAmount',
    'percentageWaiverAmount',
    'autoForgiveFirstNoShow',
    'autoForgiveCount',
    'autoForgivePeriod',
    'requirePaymentAfterCap',
    'perCustomerCap',
    'capWindowDays',
    'createdAt',
    'updatedAt',
    'deletedAt',
];

const NO_SHOW_CONFIG_ATTRS_WITH_RADIUS = [
    ...NO_SHOW_CONFIG_ATTRS_BASE,
    'arrivalRadiusMeters',
];

const BOOKING_CORE_ATTRS = [
    'id',
    'customerId',
    'driverId',
    'bookingStatusId',
    'zoneId',
    'orderAmount',
    'subTotal',
    'driverInstructionOptions',
    'driverInstructionOptions1',
    'collectionDate',
    'collectionTimeFrom',
    'collectionTimeTo',
    'deliveryDate',
    'deliveryTimeFrom',
    'deliveryTimeTo',
];

const BOOKING_ATTEMPT_ATTRS = [
    'noShowPolicyId',
    'pickupAttemptCount',
    'pickupRescheduleRequired',
    'deliveryAttemptCount',
    'maxPickupAttempts',
    'noShowFeeAccrued',
];

const POLICY_ORDER = [
    ['isDefault', 'DESC'],
    ['effectiveFrom', 'DESC'],
    ['createdAt', 'DESC'],
];

function isMissingColumnError(err, columnName) {
    if (err?.name !== 'SequelizeDatabaseError') return false;
    const sqlMessage = err?.parent?.sqlMessage || err?.original?.sqlMessage || err?.message || '';
    if (!sqlMessage.includes('Unknown column')) return false;
    if (!columnName) return true;
    return sqlMessage.includes(columnName);
}

function noShowConfigInclude(includeArrivalRadius) {
    return {
        model: noShowPolicyConfig,
        as: 'noShowConfig',
        required: false,
        attributes: includeArrivalRadius
            ? NO_SHOW_CONFIG_ATTRS_WITH_RADIUS
            : NO_SHOW_CONFIG_ATTRS_BASE,
    };
}

function applyDefaultArrivalRadius(configRow) {
    if (!configRow) return configRow;
    if (configRow.arrivalRadiusMeters == null) {
        configRow.setDataValue('arrivalRadiusMeters', DEFAULT_ARRIVAL_RADIUS_METERS);
    }
    return configRow;
}

async function findPolicyWithNoShowConfig(where, order = POLICY_ORDER) {
    try {
        return await policy.findOne({
            where,
            include: [noShowConfigInclude(true)],
            order,
        });
    } catch (err) {
        if (!isMissingColumnError(err, 'arrivalRadiusMeters')) {
            throw err;
        }
        console.warn(
            '[safeNoShowPolicyQuery] arrivalRadiusMeters missing in DB — using default radius'
        );
        const result = await policy.findOne({
            where,
            include: [noShowConfigInclude(false)],
            order,
        });
        if (result?.noShowConfig) {
            applyDefaultArrivalRadius(result.noShowConfig);
        }
        return result;
    }
}

async function findPolicyByIdWithNoShowConfig(policyId) {
    if (!policyId) return null;
    return findPolicyWithNoShowConfig({ id: policyId });
}

async function getActiveNoShowPolicySafe(zoneId) {
    const normalizedZoneId = activePoliciesService._normalizeZoneId(zoneId);

    let result = await findPolicyWithNoShowConfig(
        activePoliciesService._nowWhere('no_show', normalizedZoneId)
    );

    if (!result && normalizedZoneId !== null) {
        result = await findPolicyWithNoShowConfig(
            activePoliciesService._nowWhere('no_show', null)
        );
    }

    return result;
}

async function resolveNoShowPolicyForBooking({ noShowPolicyId, zoneId }) {
    if (noShowPolicyId) {
        const snapshotted = await findPolicyByIdWithNoShowConfig(noShowPolicyId);
        if (snapshotted) return snapshotted;
    }
    return getActiveNoShowPolicySafe(zoneId);
}

function resolveArrivalRadiusFromConfig(config) {
    const parsed = parseInt(config?.arrivalRadiusMeters, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_ARRIVAL_RADIUS_METERS;
    }
    return parsed;
}

async function resolveArrivalRadiusForBookingId(bookingId) {
    const bookingRow = await loadBookingForAttempts(bookingId, ['id', 'zoneId', 'noShowPolicyId']);
    const policyRecord = await resolveNoShowPolicyForBooking({
        noShowPolicyId: bookingRow.noShowPolicyId,
        zoneId: bookingRow.zoneId,
    });
    return resolveArrivalRadiusFromConfig(policyRecord?.noShowConfig);
}

function applyBookingAttemptDefaults(row) {
    if (!row) return row;
    if (row.pickupAttemptCount == null) row.setDataValue('pickupAttemptCount', 0);
    if (row.pickupRescheduleRequired == null) {
        row.setDataValue('pickupRescheduleRequired', false);
    }
    if (row.deliveryAttemptCount == null) row.setDataValue('deliveryAttemptCount', 0);
    if (row.maxPickupAttempts == null) row.setDataValue('maxPickupAttempts', 3);
    if (row.noShowFeeAccrued == null) row.setDataValue('noShowFeeAccrued', 0);
    if (row.noShowPolicyId == null) row.setDataValue('noShowPolicyId', null);
    return row;
}

async function loadBookingForAttempts(bookingId, extraAttrs = []) {
    const extendedAttrs = [...new Set([...BOOKING_CORE_ATTRS, ...BOOKING_ATTEMPT_ATTRS, ...extraAttrs])];

    try {
        const row = await booking.findOne({
            where: { id: bookingId },
            attributes: extendedAttrs,
        });
        if (!row) return null;
        return applyBookingAttemptDefaults(row);
    } catch (err) {
        if (!isMissingColumnError(err)) {
            throw err;
        }
        console.warn(
            '[safeNoShowPolicyQuery] booking attempt columns missing in DB — using defaults'
        );
        const row = await booking.findOne({
            where: { id: bookingId },
            attributes: [...new Set([...BOOKING_CORE_ATTRS, ...extraAttrs])],
        });
        return applyBookingAttemptDefaults(row);
    }
}

module.exports = {
    DEFAULT_ARRIVAL_RADIUS_METERS,
    isMissingColumnError,
    findPolicyByIdWithNoShowConfig,
    getActiveNoShowPolicySafe,
    resolveNoShowPolicyForBooking,
    resolveArrivalRadiusFromConfig,
    resolveArrivalRadiusForBookingId,
    loadBookingForAttempts,
};

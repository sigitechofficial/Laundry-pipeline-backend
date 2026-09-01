/**
 * Canonical booking status IDs used by admin order counts and lists.
 * Keep list filters and GET /admin/ordersCount CASE expressions in sync via these.
 *
 * Seed order (bookingStatuses seeder):
 * 1 Order Created … 17 Completed, 18 On Hold (customer), 19 Cancelled,
 * 21 Refunded, 23 Issue Resolved, 24 On Hold (agent).
 */
'use strict';

const COMPLETED = 17;
const ON_HOLD_CUSTOMER = 18;
const CANCELLED = 19;
const REFUNDED = 21;
const ON_HOLD_AGENT = 24;
const ORDER_CREATED = 1;
const DELIVERY_FAILED = 15;
const AWAITING_COLLECTION = 3;

/**
 * Statuses where a booking no longer occupies the assigned shop's capacity.
 * Everything else (including the on-hold / issue statuses) is still live work
 * sitting on that shop's schedule, so it must count against slot availability.
 */
const SLOT_RELEASING = [COMPLETED, CANCELLED, REFUNDED];

/** Statuses excluded from the Pending bucket (sidebar + pendingOrders list). */
const PENDING_EXCLUDED = [COMPLETED, ON_HOLD_CUSTOMER, CANCELLED, ON_HOLD_AGENT];

/** On-hold tab / onHoldOrders metric. */
const ON_HOLD = [ON_HOLD_CUSTOMER, ON_HOLD_AGENT];

/**
 * Pickup reschedule is only meaningful while still awaiting collection.
 * Agent history uses the same rule (status 3 + pickupRescheduleRequired).
 * Stale flags on post-pickup statuses (8, 9, 11, …) must not appear here.
 */
const PICKUP_RESCHEDULE_STATUSES = [AWAITING_COLLECTION];

/** Terminal / non-pipeline statuses for pending CASE (same as PENDING_EXCLUDED). */
const PENDING_EXCLUDED_SQL = PENDING_EXCLUDED.join(', ');

/** Active = pending pipeline but not brand-new (status 1). */
const ACTIVE_EXCLUDED = [ORDER_CREATED, ...PENDING_EXCLUDED];
const ACTIVE_EXCLUDED_SQL = ACTIVE_EXCLUDED.join(', ');

module.exports = {
    COMPLETED,
    ON_HOLD_CUSTOMER,
    CANCELLED,
    REFUNDED,
    ON_HOLD_AGENT,
    SLOT_RELEASING,
    ORDER_CREATED,
    DELIVERY_FAILED,
    AWAITING_COLLECTION,
    PENDING_EXCLUDED,
    ON_HOLD,
    PICKUP_RESCHEDULE_STATUSES,
    PENDING_EXCLUDED_SQL,
    ACTIVE_EXCLUDED,
    ACTIVE_EXCLUDED_SQL,
};

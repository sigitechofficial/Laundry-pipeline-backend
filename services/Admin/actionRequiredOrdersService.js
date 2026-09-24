'use strict';

const { Op, literal } = require('sequelize');
const {
    booking,
    users,
    billingDetails,
    bookingStatus,
    zone,
    addressDb,
    bussinessInformation,
} = require('../../models');
const {
    formatPaymentFailureReason,
} = require('../../utils/paymentFailureLabels');
const { ensureOrderTrackIds } = require('../../utils/orderTrackId');
const { attachLastStatusChanges } = require('../../utils/attachLastStatusChanges');
const {
    PICKUP_RESCHEDULE_STATUSES,
    DELIVERY_FAILED,
} = require('../../constants/bookingStatusIds');
const { EXPORT_MAX_ROWS, buildDateRangeWhere } = require('../../utils/listQuery');
const { applyActionRequiredListQuery } = require('../../utils/adminListFilters');

/** Slot end = date + timeTo (fallback end of day). Compared in DB local NOW(). */
const OVERDUE_PICKUP_SQL = literal(
    `CONCAT(DATE(\`booking\`.\`collectionDate\`), ' ', COALESCE(\`booking\`.\`collectionTimeTo\`, '23:59:59')) < NOW()`
);
const OVERDUE_DELIVERY_SQL = literal(
    `CONCAT(DATE(\`booking\`.\`deliveryDate\`), ' ', COALESCE(\`booking\`.\`deliveryTimeTo\`, '23:59:59')) < NOW()`
);

/** Still waiting for collection (not yet picked up). */
const OVERDUE_PICKUP_STATUSES = [1, 2, 3];
/** After facility / ready for customer delivery, before delivered/failed/completed. */
const OVERDUE_DELIVERY_STATUSES = [8, 9, 10, 11, 12, 13, 14];

const REASON_META = {
    payment_failed: {
        label: 'Payment failed',
        priority: 1,
        color: 'error',
        pathHint: '/orders/payment-failures',
    },
    on_hold: {
        label: 'On hold',
        priority: 2,
        color: 'warning',
        pathHint: '/orders/on-hold-orders',
    },
    needs_assignment: {
        label: 'Needs shop assignment',
        priority: 3,
        color: 'warning',
        pathHint: '/orders/pending-orders',
    },
    overdue_pickup: {
        label: 'Overdue pickup',
        priority: 4,
        color: 'warning',
        pathHint: '/orders/pending-orders',
    },
    pickup_reschedule: {
        label: 'Pickup reschedule needed',
        priority: 5,
        color: 'info',
        pathHint: '/orders/pending-orders',
    },
    overdue_delivery: {
        label: 'Overdue delivery',
        priority: 6,
        color: 'warning',
        pathHint: '/orders/pending-orders',
    },
    delivery_failed: {
        label: 'Delivery reschedule needed',
        priority: 7,
        color: 'error',
        pathHint: '/orders/pending-orders',
    },
};

function customerName(row) {
    const c = row.customer || {};
    return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.email || '—';
}

function mapRow(row, reasons) {
    const plain = row.get ? row.get({ plain: true }) : row;
    const primary = reasons[0];
    const meta = REASON_META[primary] || {
        label: primary,
        priority: 99,
        color: 'default',
    };
    return {
        id: plain.id,
        orderTrackId: plain.orderTrackId || String(plain.id),
        bookingStatusId: plain.bookingStatusId,
        bookingStatusTitle: plain.bookingStatus?.title || null,
        zoneName: plain.zone?.name || null,
        customer: {
            id: plain.customer?.id || null,
            name: customerName(plain),
            email: plain.customer?.email || null,
            phoneNum: plain.customer?.phoneNum || null,
        },
        orderAmount: plain.orderAmount,
        billingTotal: plain.billingDetail?.total ?? null,
        paymentDeliveryGate: plain.paymentDeliveryGate || null,
        paymentFailureReason: plain.lastPaymentFailureCode
            ? formatPaymentFailureReason(
                  plain.lastPaymentFailureCode,
                  plain.lastPaymentFailureMessage
              )
            : null,
        laundryShopId: plain.laundryShopId || null,
        laundryShop: plain.laundryShop || null,
        pickupRescheduleRequired: Boolean(plain.pickupRescheduleRequired),
        collectionDate: plain.collectionDate || null,
        collectionTimeTo: plain.collectionTimeTo || null,
        deliveryDate: plain.deliveryDate || null,
        deliveryTimeTo: plain.deliveryTimeTo || null,
        reasons,
        reasonLabels: reasons.map((r) => REASON_META[r]?.label || r),
        primaryReason: primary,
        primaryLabel: meta.label,
        priority: meta.priority,
        createdAt: plain.createdAt,
        updatedAt: plain.updatedAt,
        lastPaymentFailureAt: plain.lastPaymentFailureAt || null,
    };
}

/**
 * Orders that need admin attention — single feed for the Action Required tab.
 *
 * Two modes:
 *  - legacy `limit` (per-queue fetch cap, used by countActionRequiredOrders / forCount)
 *  - `listQuery` (req.query-like: search, sortBy, sortDir, page, limit, export):
 *    every queue is fetched up to EXPORT_MAX_ROWS, merged, then the shared
 *    in-memory list contract is applied AFTER reason/zone/date filters and the
 *    response carries the standard `pagination` block.
 *
 * @param {{
 *   limit?: number|string|null, zoneId?: string|number|null, forCount?: boolean,
 *   reason?: string|null, startDate?: string|null, endDate?: string|null,
 *   listQuery?: Record<string, unknown>|null,
 * }} options
 */
async function listActionRequiredOrders({
    limit = null,
    zoneId = null,
    forCount = false,
    reason = null,
    startDate = null,
    endDate = null,
    listQuery = null,
} = {}) {
    const reasonFilter =
        reason && String(reason).trim() && String(reason).trim() !== 'all'
            ? String(reason).trim()
            : null;
    const paged = !forCount && listQuery && typeof listQuery === 'object';
    const limitProvided =
        limit !== undefined && limit !== null && String(limit).trim() !== '';
    const requestedLimit = limitProvided
        ? Number(limit)
        : reasonFilter
          ? 1000
          : 150;
    // Paged mode: page/limit are a window over the merged set, so every queue is
    // fetched up to the export ceiling and the window is applied in memory.
    const capped = paged
        ? EXPORT_MAX_ROWS
        : forCount
          ? Math.min(Math.max(requestedLimit || 10000, 1), 50000)
          : reasonFilter
            ? Math.min(Math.max(requestedLimit || 1000, 1), 2000)
            : Math.min(Math.max(requestedLimit || 150, 1), 300);
    const scopedFilter = {};
    if (zoneId != null && String(zoneId).trim() !== '') {
        scopedFilter.zoneId = parseInt(zoneId, 10);
    }
    // Inclusive calendar-day range on order placed (YYYY-MM-DD or ISO); either bound optional.
    const placedRange = buildDateRangeWhere(startDate, endDate);
    if (placedRange) scopedFilter.createdAt = placedRange;

    const include = [
        {
            model: users,
            as: 'customer',
            attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'countryCode'],
            required: false,
        },
        {
            model: billingDetails,
            as: 'billingDetail',
            attributes: ['total', 'paymentStatus'],
            required: false,
        },
        {
            model: bookingStatus,
            as: 'bookingStatus',
            attributes: ['id', 'title'],
            required: false,
        },
        {
            model: zone,
            as: 'zone',
            attributes: ['id', 'name'],
            required: false,
        },
        {
            model: addressDb,
            as: 'laundryShop',
            required: false,
            attributes: ['id', 'userId'],
            include: {
                model: bussinessInformation,
                attributes: ['id', 'shopName'],
                required: false,
            },
        },
    ];

    const attrs = [
        'id',
        'orderTrackId',
        'bookingStatusId',
        'customerId',
        'laundryShopId',
        'driverId',
        'deliveryDriverId',
        'zoneId',
        'orderAmount',
        'paymentType',
        'paymentDeliveryGate',
        'autoChargeStatus',
        'lastPaymentFailureCode',
        'lastPaymentFailureMessage',
        'lastPaymentFailureAt',
        'pickupRescheduleRequired',
        'agentBroadcastHeld',
        'adminAssignedShopId',
        'collectionDate',
        'collectionTimeFrom',
        'collectionTimeTo',
        'deliveryDate',
        'deliveryTimeFrom',
        'deliveryTimeTo',
        'createdAt',
        'updatedAt',
    ];

    const want = (key) => !reasonFilter || reasonFilter === key;

    const empty = Promise.resolve([]);

    const [
        paymentFailed,
        onHold,
        needsAssignment,
        overduePickup,
        pickupReschedule,
        overdueDelivery,
        deliveryFailed,
    ] = await Promise.all([
            want('payment_failed')
                ? booking.findAll({
                      where: {
                          ...scopedFilter,
                          paymentType: 'card',
                          paymentDeliveryGate: 'waiting_admin',
                          bookingStatusId: { [Op.lt]: 17 },
                      },
                      include,
                      attributes: attrs,
                      order: [['lastPaymentFailureAt', 'DESC']],
                      limit: capped,
                  })
                : empty,
            want('on_hold')
                ? booking.findAll({
                      where: {
                          ...scopedFilter,
                          bookingStatusId: { [Op.in]: [18, 24] },
                      },
                      include,
                      attributes: attrs,
                      order: [['updatedAt', 'DESC']],
                      limit: capped,
                  })
                : empty,
            want('needs_assignment')
                ? booking.findAll({
                      where: {
                          ...scopedFilter,
                          laundryShopId: null,
                          bookingStatusId: { [Op.in]: [1, 2, 3] },
                      },
                      include,
                      attributes: attrs,
                      order: [['createdAt', 'DESC']],
                      limit: capped,
                  })
                : empty,
            want('overdue_pickup')
                ? booking.findAll({
                      where: {
                          ...scopedFilter,
                          bookingStatusId: { [Op.in]: OVERDUE_PICKUP_STATUSES },
                          collectionDate: { [Op.ne]: null },
                          [Op.and]: [OVERDUE_PICKUP_SQL],
                      },
                      include,
                      attributes: attrs,
                      order: [['collectionDate', 'ASC']],
                      limit: capped,
                  })
                : empty,
            want('pickup_reschedule')
                ? booking.findAll({
                      where: {
                          ...scopedFilter,
                          pickupRescheduleRequired: true,
                          bookingStatusId: {
                              [Op.in]: PICKUP_RESCHEDULE_STATUSES,
                          },
                      },
                      include,
                      attributes: attrs,
                      order: [['updatedAt', 'DESC']],
                      limit: capped,
                  })
                : empty,
            want('overdue_delivery')
                ? booking.findAll({
                      where: {
                          ...scopedFilter,
                          bookingStatusId: { [Op.in]: OVERDUE_DELIVERY_STATUSES },
                          deliveryDate: { [Op.ne]: null },
                          [Op.and]: [OVERDUE_DELIVERY_SQL],
                      },
                      include,
                      attributes: attrs,
                      order: [['deliveryDate', 'ASC']],
                      limit: capped,
                  })
                : empty,
            want('delivery_failed')
                ? booking.findAll({
                      where: {
                          ...scopedFilter,
                          bookingStatusId: DELIVERY_FAILED,
                      },
                      include,
                      attributes: attrs,
                      order: [['updatedAt', 'DESC']],
                      limit: capped,
                  })
                : empty,
        ]);

    const byId = new Map();

    const add = (rows, reasonKey) => {
        for (const row of rows) {
            const id = row.id;
            if (!byId.has(id)) {
                byId.set(id, { row, reasons: [] });
            }
            const entry = byId.get(id);
            if (!entry.reasons.includes(reasonKey)) entry.reasons.push(reasonKey);
        }
    };

    add(paymentFailed, 'payment_failed');
    add(onHold, 'on_hold');
    add(needsAssignment, 'needs_assignment');
    add(overduePickup, 'overdue_pickup');
    add(pickupReschedule, 'pickup_reschedule');
    add(overdueDelivery, 'overdue_delivery');
    add(deliveryFailed, 'delivery_failed');

    await ensureOrderTrackIds(
        booking,
        Array.from(byId.values()).map((entry) => entry.row)
    );

    const items = Array.from(byId.values())
        .map(({ row, reasons }) => {
            // Defensive: delivery-failed status must not keep a pickup-reschedule chip.
            const statusId = Number(
                row.bookingStatusId ?? row.get?.('bookingStatusId')
            );
            let cleanReasons = reasons;
            if (statusId === DELIVERY_FAILED) {
                cleanReasons = reasons.filter(
                    (r) => r !== 'pickup_reschedule' && r !== 'overdue_pickup'
                );
            }
            cleanReasons.sort(
                (a, b) =>
                    (REASON_META[a]?.priority || 99) - (REASON_META[b]?.priority || 99)
            );
            const mapped = mapRow(row, cleanReasons);
            if (statusId === DELIVERY_FAILED) {
                mapped.pickupRescheduleRequired = false;
            }
            return mapped;
        })
        .sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return bt - at;
        });

    const scoped = reasonFilter
        ? items.filter((row) => (row.reasons || []).includes(reasonFilter))
        : items;

    let resultItems;
    let pagination = null;
    let searchTerm = '';
    if (forCount) {
        resultItems = scoped;
    } else if (paged) {
        const listed = applyActionRequiredListQuery(scoped, listQuery);
        resultItems = listed.rows;
        pagination = listed.pagination;
        searchTerm = listed.search;
    } else {
        resultItems = scoped.slice(0, capped);
    }
    if (!forCount) {
        await attachLastStatusChanges(booking.sequelize, resultItems);
    }

    const countsByReason = {
        payment_failed: paymentFailed.length,
        on_hold: onHold.length,
        needs_assignment: needsAssignment.length,
        overdue_pickup: overduePickup.length,
        pickup_reschedule: pickupReschedule.length,
        overdue_delivery: overdueDelivery.length,
        delivery_failed: deliveryFailed.length,
    };

    const filteredCount = pagination ? pagination.totalRecords : scoped.length;

    return {
        items: resultItems,
        // count/totalCount: rows matching reason + zone + date (+ search in paged mode)
        count: filteredCount,
        totalCount: filteredCount,
        allReasonsCount: items.length,
        reason: reasonFilter || 'all',
        countsByReason,
        reasonMeta: REASON_META,
        ...(pagination ? { pagination, search: searchTerm } : {}),
    };
}

async function countActionRequiredOrders(filters = {}) {
    const listed = await listActionRequiredOrders({
        limit: 50000,
        zoneId: filters.zoneId,
        startDate: filters.startDate,
        endDate: filters.endDate,
        forCount: true,
    });
    return {
        actionRequiredCount: listed.totalCount ?? listed.count,
        actionRequiredBreakdown: listed.countsByReason,
    };
}

module.exports = {
    listActionRequiredOrders,
    countActionRequiredOrders,
    REASON_META,
};

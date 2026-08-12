'use strict';

const { Op } = require('sequelize');
const {
    booking,
    users,
    billingDetails,
    bookingStatus,
    zone,
    addressDb,
} = require('../../models');
const {
    formatPaymentFailureReason,
} = require('../../utils/paymentFailureLabels');

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
    needs_staff: {
        label: 'Needs staff driver',
        priority: 4,
        color: 'warning',
        pathHint: '/orders',
    },
    pickup_reschedule: {
        label: 'Pickup reschedule needed',
        priority: 5,
        color: 'info',
        pathHint: '/orders/pending-orders',
    },
    delivery_failed: {
        label: 'Delivery failed',
        priority: 6,
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
        pickupRescheduleRequired: Boolean(plain.pickupRescheduleRequired),
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
 */
async function listActionRequiredOrders({ limit = 150, zoneId = null } = {}) {
    const capped = Math.min(Math.max(Number(limit) || 150, 1), 300);
    const zoneFilter =
        zoneId != null && String(zoneId).trim() !== ''
            ? { zoneId: parseInt(zoneId, 10) }
            : {};

    const include = [
        {
            model: users,
            as: 'customer',
            attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum'],
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
        'createdAt',
        'updatedAt',
    ];

    const [paymentFailed, onHold, needsAssignment, shopHeldStaff, pickupReschedule, deliveryFailed] =
        await Promise.all([
            booking.findAll({
                where: {
                    ...zoneFilter,
                    paymentType: 'card',
                    paymentDeliveryGate: 'waiting_admin',
                    bookingStatusId: { [Op.lt]: 17 },
                },
                include,
                attributes: attrs,
                order: [['lastPaymentFailureAt', 'DESC']],
                limit: capped,
            }),
            booking.findAll({
                where: {
                    ...zoneFilter,
                    bookingStatusId: { [Op.in]: [18, 24] },
                },
                include,
                attributes: attrs,
                order: [['updatedAt', 'DESC']],
                limit: capped,
            }),
            booking.findAll({
                where: {
                    ...zoneFilter,
                    laundryShopId: null,
                    bookingStatusId: { [Op.in]: [1, 2, 3] },
                },
                include,
                attributes: attrs,
                order: [['createdAt', 'DESC']],
                limit: capped,
            }),
            booking.findAll({
                where: {
                    ...zoneFilter,
                    laundryShopId: { [Op.ne]: null },
                    bookingStatusId: { [Op.in]: [4, 5, 6, 7, 13, 14] },
                },
                include: [
                    ...include,
                    {
                        model: addressDb,
                        as: 'laundryShop',
                        attributes: ['id', 'userId'],
                        required: true,
                    },
                ],
                attributes: attrs,
                order: [['updatedAt', 'DESC']],
                limit: Math.min(capped * 3, 300),
            }),
            booking.findAll({
                where: {
                    ...zoneFilter,
                    pickupRescheduleRequired: true,
                    bookingStatusId: { [Op.notIn]: [17, 19] },
                },
                include,
                attributes: attrs,
                order: [['updatedAt', 'DESC']],
                limit: capped,
            }),
            booking.findAll({
                where: {
                    ...zoneFilter,
                    bookingStatusId: 15,
                },
                include,
                attributes: attrs,
                order: [['updatedAt', 'DESC']],
                limit: capped,
            }),
        ]);

    const needsStaff = shopHeldStaff
        .filter((row) => {
            const plain = row.get ? row.get({ plain: true }) : row;
            const ownerId =
                plain.laundryShop?.userId != null
                    ? Number(plain.laundryShop.userId)
                    : null;
            if (!ownerId) return false;
            const status = Number(plain.bookingStatusId);
            const pickupId =
                plain.driverId != null ? Number(plain.driverId) : null;
            const deliveryId =
                plain.deliveryDriverId != null
                    ? Number(plain.deliveryDriverId)
                    : null;
            if ([4, 5, 6, 7].includes(status)) {
                return pickupId == null || pickupId === ownerId;
            }
            if ([13, 14].includes(status)) {
                return deliveryId == null || deliveryId === ownerId;
            }
            return false;
        })
        .slice(0, capped);

    const byId = new Map();

    const add = (rows, reason) => {
        for (const row of rows) {
            const id = row.id;
            if (!byId.has(id)) {
                byId.set(id, { row, reasons: [] });
            }
            const entry = byId.get(id);
            if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
        }
    };

    add(paymentFailed, 'payment_failed');
    add(onHold, 'on_hold');
    add(needsAssignment, 'needs_assignment');
    add(needsStaff, 'needs_staff');
    add(pickupReschedule, 'pickup_reschedule');
    add(deliveryFailed, 'delivery_failed');

    const items = Array.from(byId.values())
        .map(({ row, reasons }) => {
            reasons.sort(
                (a, b) =>
                    (REASON_META[a]?.priority || 99) - (REASON_META[b]?.priority || 99)
            );
            return mapRow(row, reasons);
        })
        .sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return bt - at;
        })
        .slice(0, capped);

    const countsByReason = {
        payment_failed: paymentFailed.length,
        on_hold: onHold.length,
        needs_assignment: needsAssignment.length,
        needs_staff: needsStaff.length,
        pickup_reschedule: pickupReschedule.length,
        delivery_failed: deliveryFailed.length,
    };

    return {
        items,
        count: items.length,
        countsByReason,
        reasonMeta: REASON_META,
    };
}

async function countActionRequiredOrders(filters = {}) {
    const listed = await listActionRequiredOrders({
        limit: 300,
        zoneId: filters.zoneId,
    });
    return {
        actionRequiredCount: listed.count,
        actionRequiredBreakdown: listed.countsByReason,
    };
}

module.exports = {
    listActionRequiredOrders,
    countActionRequiredOrders,
    REASON_META,
};

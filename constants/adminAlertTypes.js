'use strict';

/**
 * Admin alert types — each maps to a toggle in the admin panel.
 * All enabled by default until an admin disables a specific flag.
 */
const ADMIN_ALERT_TYPES = {
    pickup_late: {
        label: 'Pickup Late',
        description:
            'Driver is more than 15 minutes late for pickup. Agent notifies office.',
        category: 'pickup',
        defaultEnabled: true,
        priority: 'high',
    },
    delivery_late: {
        label: 'Delivery Late',
        description:
            'Driver is more than 15 minutes late for delivery. Agent notifies office.',
        category: 'delivery',
        defaultEnabled: true,
        priority: 'high',
    },
    driver_arrived: {
        label: 'Driver Arrived',
        description: 'Driver has arrived at the customer location.',
        category: 'operations',
        defaultEnabled: false,
        priority: 'normal',
    },
    agent_assistance: {
        label: 'Agent Assistance',
        description: 'Agent requests admin help (general SOS).',
        category: 'operations',
        defaultEnabled: true,
        priority: 'high',
    },
    payment_failed: {
        label: 'Payment Failed',
        description:
            'Card auto-charge failed. Order blocked until admin resolves payment.',
        category: 'payment',
        defaultEnabled: true,
        priority: 'high',
    },
    pickup_failed: {
        label: 'Pickup Failed',
        description:
            'Pickup attempt failed. Customer must reschedule collection.',
        category: 'pickup',
        defaultEnabled: true,
        priority: 'high',
    },
    pickup_cancelled: {
        label: 'Pickup Cancelled',
        description:
            'Maximum pickup attempts reached. Order cancelled automatically.',
        category: 'pickup',
        defaultEnabled: true,
        priority: 'high',
    },
    delivery_failed: {
        label: 'Delivery Failed',
        description:
            'Delivery attempt failed. Customer must reschedule delivery.',
        category: 'delivery',
        defaultEnabled: true,
        priority: 'high',
    },
    no_eligible_agent: {
        label: 'Manual Assignment Needed',
        description:
            'No agent in zone offers all selected services. Assign manually.',
        category: 'orders',
        defaultEnabled: true,
        priority: 'high',
    },
    new_order: {
        label: 'New Order',
        description: 'A new order was placed and needs attention.',
        category: 'orders',
        defaultEnabled: false,
        priority: 'normal',
    },
    order_on_hold: {
        label: 'Order On Hold',
        description: 'Order placed on hold — customer or agent action required.',
        category: 'orders',
        defaultEnabled: true,
        priority: 'normal',
    },
    order_cancelled: {
        label: 'Order Cancelled',
        description: 'Order was cancelled by customer or admin.',
        category: 'orders',
        defaultEnabled: true,
        priority: 'normal',
    },
    refund_requested: {
        label: 'Refund / Issue',
        description: 'Order moved to refund or issue state.',
        category: 'orders',
        defaultEnabled: true,
        priority: 'high',
    },
    agent_approval_pending: {
        label: 'Agent Approval Pending',
        description: 'New agent registration awaiting admin approval.',
        category: 'operations',
        defaultEnabled: true,
        priority: 'normal',
    },
};

const ADMIN_ALERT_TYPE_KEYS = Object.keys(ADMIN_ALERT_TYPES);

/** Map legacy FCM data.type values to admin alert types. */
const LEGACY_TYPE_MAP = {
    no_eligible_agent_for_services: 'no_eligible_agent',
    PAYMENT_FAILED: 'payment_failed',
    pickup_failed: 'pickup_failed',
    pickup_cancelled: 'pickup_cancelled',
    delivery_failed: 'delivery_failed',
    agent_assistance: 'agent_assistance',
    driver_arrived: 'driver_arrived',
    pickup_late: 'pickup_late',
    delivery_late: 'delivery_late',
    new_order: 'new_order',
    order_on_hold: 'order_on_hold',
    order_cancelled: 'order_cancelled',
    refund_requested: 'refund_requested',
    agent_approval_pending: 'agent_approval_pending',
};

const PICKUP_STATUS_IDS = new Set([3, 4, 5, 6, 7]);
const DELIVERY_STATUS_IDS = new Set([12, 13, 14, 15]);

function isValidAlertType(type) {
    return ADMIN_ALERT_TYPE_KEYS.includes(type);
}

/**
 * Infer alert type from legacy agent/admin push payloads.
 */
function inferAlertType({ title = '', body = '', data = {}, bookingStatusId = null } = {}) {
    const explicit = data.alertType || data.type;
    if (explicit && LEGACY_TYPE_MAP[explicit]) {
        return LEGACY_TYPE_MAP[explicit];
    }
    if (explicit && isValidAlertType(explicit)) {
        return explicit;
    }

    const combined = `${title} ${body}`.toLowerCase();

    if (combined.includes('late')) {
        if (bookingStatusId != null) {
            if (PICKUP_STATUS_IDS.has(Number(bookingStatusId))) return 'pickup_late';
            if (DELIVERY_STATUS_IDS.has(Number(bookingStatusId))) return 'delivery_late';
        }
        return 'agent_assistance';
    }

    if (combined.includes('arrived')) {
        return 'driver_arrived';
    }

    if (combined.includes('manual assignment') || combined.includes('no agent')) {
        return 'no_eligible_agent';
    }

    if (combined.includes('payment failed') || combined.includes('waiting for admin')) {
        return 'payment_failed';
    }

    return 'agent_assistance';
}

module.exports = {
    ADMIN_ALERT_TYPES,
    ADMIN_ALERT_TYPE_KEYS,
    LEGACY_TYPE_MAP,
    isValidAlertType,
    inferAlertType,
};

/**
 * Customer-facing order track timeline.
 * Merges bookingHistories + booking_attempts into a detailed, newest-first list.
 */

const CUSTOMER_STATUS_COPY = {
    1: {
        title: "Order Created",
        message: "Your order has been created.",
    },
    2: {
        title: "Order Confirmed",
        message: "Your booking is confirmed and ready for collection.",
    },
    3: {
        title: "Awaiting Collection",
        message: "We are scheduled to collect your laundry at the selected slot.",
    },
    4: {
        title: "Out for Pickup",
        message: "Your driver is on the way to collect your laundry.",
    },
    5: {
        title: "Driver Reached Pickup",
        message: "Your driver has arrived at the collection address.",
    },
    6: {
        title: "Collecting Items",
        message: "Your driver is collecting and checking your items.",
    },
    7: {
        title: "In Transit to Facility",
        message: "Your laundry has been collected and is heading to the facility.",
    },
    8: {
        title: "Arrived at Facility",
        message: "Your laundry has arrived at the laundry facility.",
    },
    9: {
        title: "Items Checked In",
        message: "Your items have been checked in at the facility.",
    },
    10: {
        title: "Invoice Generated",
        message: "Your invoice has been generated.",
    },
    11: {
        title: "Processing",
        message: "Your items are being cleaned and processed.",
    },
    12: {
        title: "Ready for Delivery",
        message: "Your laundry is ready and waiting for delivery.",
    },
    13: {
        title: "Out for Delivery",
        message: "Your laundry is on the way to you.",
    },
    14: {
        title: "Driver Reached",
        message: "Your driver has arrived at the delivery address.",
    },
    15: {
        title: "Delivery Failed",
        message: "We were unable to complete delivery. Please reschedule.",
    },
    16: {
        title: "Delivered",
        message: "Your laundry has been delivered successfully.",
    },
    17: {
        title: "Completed",
        message: "Your order is complete.",
    },
    18: {
        title: "On Hold",
        message: "Your order is temporarily on hold and needs your response.",
    },
    19: {
        title: "Cancelled",
        message: "This order has been cancelled.",
    },
    20: {
        title: "Returned to Processing",
        message: "Your order has been returned to processing.",
    },
    21: {
        title: "Refunded",
        message: "A refund has been issued for this order.",
    },
    22: {
        title: "Issue Resolving",
        message: "We are working on an issue with your order.",
    },
    23: {
        title: "Issue Resolved",
        message: "The issue with your order has been resolved.",
    },
    24: {
        title: "On Hold",
        message: "Your order is on hold while we wait for the shop response.",
    },
};

const EXCEPTION_STATUS_IDS = new Set([15, 18, 19, 21, 22, 24]);

function padTime(timeValue) {
    if (!timeValue) return "00:00:00";
    const raw = String(timeValue).trim();
    if (/^\d{1,2}:\d{2}:\d{2}$/.test(raw)) return raw;
    if (/^\d{1,2}:\d{2}$/.test(raw)) return `${raw}:00`;
    return raw;
}

function normalizeDatePart(dateValue) {
    if (!dateValue) return null;
    if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
        return dateValue.toISOString().slice(0, 10);
    }
    const raw = String(dateValue).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString().slice(0, 10);
    }
    return raw;
}

function toSortableTs(datePart, timePart, fallbackDate) {
    const date = normalizeDatePart(datePart) || normalizeDatePart(fallbackDate);
    if (!date) return 0;
    const time = padTime(timePart);
    const ms = Date.parse(`${date}T${time}`);
    return Number.isFinite(ms) ? ms : Date.parse(`${date}T00:00:00`) || 0;
}

function getStatusCopy(statusId, fallbackTitle, fallbackMessage) {
    const copy = CUSTOMER_STATUS_COPY[Number(statusId)];
    if (copy) return copy;
    return {
        title: fallbackTitle || "Order Update",
        message: fallbackMessage || "Your order status was updated.",
    };
}

function buildHistoryEvents(histories = []) {
    return (histories || [])
        .map((row, index) => {
            const statusId = Number(row?.bookingStatus?.id ?? row?.bookingStatusId);
            const copy = getStatusCopy(
                statusId,
                row?.bookingStatus?.title,
                row?.bookingStatus?.description
            );
            const date = normalizeDatePart(row?.date);
            const time = padTime(row?.time);
            return {
                id: `history-${row?.id || index}`,
                source: "history",
                kind: "status",
                statusId: Number.isFinite(statusId) ? statusId : null,
                title: copy.title,
                message: copy.message,
                attemptNumber: null,
                attemptType: null,
                failureReason: null,
                feeAmount: null,
                feeCurrency: null,
                date,
                time,
                occurredAt: date ? `${date}T${time}` : null,
                sortTs: toSortableTs(date, time, row?.createdAt),
                isException: EXCEPTION_STATUS_IDS.has(statusId),
            };
        })
        .filter((event) => event.title);
}

function stampFromDate(dateObj, fallback) {
    if (dateObj && !Number.isNaN(dateObj.getTime())) {
        return {
            date: dateObj.toISOString().slice(0, 10),
            time: dateObj.toISOString().slice(11, 19),
            occurredAt: dateObj.toISOString(),
            sortTs: dateObj.getTime(),
        };
    }
    const date = normalizeDatePart(fallback);
    const time = "00:00:00";
    return {
        date,
        time,
        occurredAt: date ? `${date}T${time}` : null,
        sortTs: toSortableTs(date, time, fallback),
    };
}

function buildAttemptEvents(attempts = []) {
    const events = [];

    for (const attempt of attempts || []) {
        const attemptType = attempt?.attemptType === "delivery" ? "delivery" : "pickup";
        const attemptNumber = Number(attempt?.attemptNumber) || null;
        const status = String(attempt?.status || "").toLowerCase();

        if (status === "failed") {
            const failedAt = attempt?.failedAt ? new Date(attempt.failedAt) : null;
            const stamp = stampFromDate(
                failedAt,
                attempt?.updatedAt || attempt?.createdAt
            );
            const reason = attempt?.failureReason
                ? String(attempt.failureReason).trim()
                : null;
            const title =
                attemptType === "delivery"
                    ? "Delivery Attempt Failed"
                    : "Pickup Attempt Failed";
            const attemptLabel = attemptNumber ? `Attempt ${attemptNumber}` : "Attempt";
            const message = reason
                ? `${attemptLabel} was unsuccessful — ${reason}.`
                : `${attemptLabel} was unsuccessful. Please reschedule your ${attemptType} slot.`;

            events.push({
                id: `attempt-failed-${attempt.id}`,
                source: "attempt",
                kind:
                    attemptType === "delivery"
                        ? "delivery_failed"
                        : "pickup_failed",
                statusId: null,
                title,
                message,
                attemptNumber,
                attemptType,
                failureReason: reason,
                feeAmount:
                    attempt?.feeAmount != null
                        ? parseFloat(attempt.feeAmount)
                        : null,
                feeCurrency: attempt?.feeCurrency || null,
                ...stamp,
                isException: true,
            });
            continue;
        }

        if (status === "arrived") {
            const arrivedAt = attempt?.arrivedAt
                ? new Date(attempt.arrivedAt)
                : null;
            const stamp = stampFromDate(arrivedAt, attempt?.createdAt);
            events.push({
                id: `attempt-arrived-${attempt.id}`,
                source: "attempt",
                kind:
                    attemptType === "delivery"
                        ? "delivery_arrived"
                        : "pickup_arrived",
                statusId: null,
                title:
                    attemptType === "delivery"
                        ? "Driver Arrived for Delivery"
                        : "Driver Arrived for Pickup",
                message:
                    attemptType === "delivery"
                        ? "Your driver has arrived and is waiting to deliver your laundry."
                        : "Your driver has arrived and is waiting to collect your laundry.",
                attemptNumber,
                attemptType,
                failureReason: null,
                feeAmount: null,
                feeCurrency: null,
                ...stamp,
                isException: false,
            });
            continue;
        }

        if (status === "unattended") {
            const completedAt = attempt?.completedAt
                ? new Date(attempt.completedAt)
                : attempt?.updatedAt
                  ? new Date(attempt.updatedAt)
                  : null;
            const stamp = stampFromDate(completedAt, attempt?.createdAt);
            const method = attempt?.unattendedMethod
                ? String(attempt.unattendedMethod).replace(/_/g, " ")
                : null;
            events.push({
                id: `attempt-unattended-${attempt.id}`,
                source: "attempt",
                kind:
                    attemptType === "delivery"
                        ? "delivery_unattended"
                        : "pickup_unattended",
                statusId: null,
                title:
                    attemptType === "delivery"
                        ? "Delivered Unattended"
                        : "Collected Unattended",
                message: method
                    ? `Completed without the customer present (${method}).`
                    : "Completed without the customer present.",
                attemptNumber,
                attemptType,
                failureReason: null,
                feeAmount: null,
                feeCurrency: null,
                ...stamp,
                isException: false,
            });
        }
    }

    return events;
}

/** Statuses that repeat on every failed delivery retry loop. */
const DELIVERY_LOOP_STATUS_IDS = new Set([13, 14]);
/** Agent batch-creates these twins together — keep the later customer-facing one. */
const BATCH_TWIN_DROP = new Map([
    [6, 7], // Collecting → In Transit
    [10, 11], // Invoice Generated → Processing
    [16, 17], // Delivered → Completed
]);
const FIVE_MIN_MS = 5 * 60 * 1000;

function compareEventsAsc(a, b) {
    if (a.sortTs !== b.sortTs) return a.sortTs - b.sortTs;
    return String(a.id).localeCompare(String(b.id));
}

/**
 * Collapse noisy bookingHistory + attempt rows into a customer-friendly story:
 * - one row per normal status (latest)
 * - unique failed attempts (by type + attemptNumber)
 * - hide superseded pickup/delivery loop rows after return-to-awaiting / ready
 * - drop batch twin + duplicate arrived events
 */
function collapseTrackTimelineEvents(events = []) {
    if (!Array.isArray(events) || events.length === 0) return [];

    let list = [...events].sort(compareEventsAsc);

    // 1) Failed attempts: keep latest per attemptType + attemptNumber
    const seenFailKeys = new Set();
    const failsNewestFirst = [...list]
        .filter((e) => e.kind === "pickup_failed" || e.kind === "delivery_failed")
        .sort((a, b) => compareEventsAsc(b, a));
    const keepFailIds = new Set();
    for (const fail of failsNewestFirst) {
        const key = `${fail.attemptType || "unknown"}:${fail.attemptNumber ?? "x"}`;
        if (seenFailKeys.has(key)) continue;
        seenFailKeys.add(key);
        keepFailIds.add(fail.id);
    }
    list = list.filter((e) => {
        if (e.kind === "pickup_failed" || e.kind === "delivery_failed") {
            return keepFailIds.has(e.id);
        }
        return true;
    });

    // 2) Drop attempt-arrived when history already has reached status nearby
    list = list.filter((event) => {
        if (event.kind !== "pickup_arrived" && event.kind !== "delivery_arrived") {
            return true;
        }
        const matchStatusId = event.kind === "delivery_arrived" ? 14 : 5;
        return !list.some(
            (other) =>
                other.source === "history" &&
                other.statusId === matchStatusId &&
                Math.abs(other.sortTs - event.sortTs) <= FIVE_MIN_MS
        );
    });

    // 3) Drop batch twin (e.g. status 10 when 11 follows within 5 min)
    list = list.filter((event, index) => {
        if (event.source !== "history" || event.statusId == null) return true;
        const twin = BATCH_TWIN_DROP.get(event.statusId);
        if (twin == null) return true;
        return !list.slice(index + 1).some(
            (other) =>
                other.source === "history" &&
                other.statusId === twin &&
                other.sortTs - event.sortTs >= 0 &&
                other.sortTs - event.sortTs <= FIVE_MIN_MS
        );
    });

    // 4) Latest history row per statusId (exceptions keep latest too — attempts carry fail detail)
    const latestByStatus = new Map();
    for (const event of list) {
        if (event.source !== "history" || event.statusId == null) continue;
        latestByStatus.set(event.statusId, event);
    }
    list = list.filter((event) => {
        if (event.source !== "history" || event.statusId == null) return true;
        return latestByStatus.get(event.statusId)?.id === event.id;
    });

    // 5) Hide pickup loop rows superseded by a later "Awaiting Collection"
    const latestAwaitingTs = latestByStatus.get(3)?.sortTs;
    if (latestAwaitingTs != null) {
        list = list.filter((event) => {
            if (event.source !== "history") return true;
            if (![4, 5, 6].includes(event.statusId)) return true;
            return event.sortTs >= latestAwaitingTs;
        });
    }

    // 6) Hide delivery loop rows superseded by later ready / failed / completed
    const deliveryResetTs = Math.max(
        latestByStatus.get(12)?.sortTs || 0,
        latestByStatus.get(15)?.sortTs || 0,
        latestByStatus.get(16)?.sortTs || 0,
        latestByStatus.get(17)?.sortTs || 0
    );
    if (deliveryResetTs > 0) {
        list = list.filter((event) => {
            if (event.source !== "history") return true;
            if (!DELIVERY_LOOP_STATUS_IDS.has(event.statusId)) return true;
            return event.sortTs >= deliveryResetTs;
        });
    }

    // 7) Consecutive same history status (safety net)
    const collapsed = [];
    for (const event of list) {
        const prev = collapsed[collapsed.length - 1];
        if (
            prev &&
            prev.source === "history" &&
            event.source === "history" &&
            prev.statusId != null &&
            prev.statusId === event.statusId
        ) {
            collapsed[collapsed.length - 1] = event;
            continue;
        }
        collapsed.push(event);
    }

    return collapsed;
}

function buildActionRequired(bookingPlain) {
    const statusId = Number(bookingPlain?.bookingStatusId);
    if (statusId === 15) {
        return {
            type: "delivery",
            title: "Action Required",
            message:
                "We were unable to deliver your laundry. Please reschedule your delivery slot.",
            cta: "reschedule",
        };
    }

    if (statusId === 3 && Boolean(bookingPlain?.pickupRescheduleRequired)) {
        return {
            type: "pickup",
            title: "Action Required",
            message:
                "We were unable to collect your laundry. Please reschedule your collection slot.",
            cta: "reschedule",
        };
    }

    return null;
}

function buildOrderTrackTimeline(bookingPlain) {
    const histories = Array.isArray(bookingPlain?.bookingHistories)
        ? bookingPlain.bookingHistories
        : Array.isArray(bookingPlain?.bookingHistory)
          ? bookingPlain.bookingHistory
          : [];
    const attempts = Array.isArray(bookingPlain?.attempts)
        ? bookingPlain.attempts
        : [];

    const rawTimeline = [
        ...buildHistoryEvents(histories),
        ...buildAttemptEvents(attempts),
    ];
    const timeline = collapseTrackTimelineEvents(rawTimeline)
        .sort((a, b) => {
            if (b.sortTs !== a.sortTs) return b.sortTs - a.sortTs;
            return String(b.id).localeCompare(String(a.id));
        })
        .map(({ sortTs, ...event }) => event);

    const currentStatusId = Number(bookingPlain?.bookingStatusId);
    const currentCopy = getStatusCopy(
        currentStatusId,
        bookingPlain?.bookingStatus?.title,
        bookingPlain?.bookingStatus?.description
    );

    return {
        currentStatus: {
            id: Number.isFinite(currentStatusId) ? currentStatusId : null,
            title: currentCopy.title,
            message: currentCopy.message,
            rawTitle: bookingPlain?.bookingStatus?.title || null,
        },
        actionRequired: buildActionRequired(bookingPlain),
        timeline,
    };
}

module.exports = {
    CUSTOMER_STATUS_COPY,
    buildOrderTrackTimeline,
    buildActionRequired,
    getStatusCopy,
    collapseTrackTimelineEvents,
};

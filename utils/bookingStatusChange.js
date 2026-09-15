'use strict';

const { actorLabel, ACTOR_TYPES } = require('./bookingActorContext');

/** Statuses the field driver typically writes. */
const DRIVER_STATUS_IDS = new Set([4, 5, 6, 7, 8, 13, 14, 15, 16]);
/** Shop / agent app facility work. */
const AGENT_STATUS_IDS = new Set([3, 9, 10, 11, 12, 17, 23, 24]);
const CUSTOMER_STATUS_IDS = new Set([1, 2, 18]);

function inferActorFromStatusId(statusId) {
    const id = Number(statusId);
    if (DRIVER_STATUS_IDS.has(id)) return ACTOR_TYPES.DRIVER;
    if (AGENT_STATUS_IDS.has(id)) return ACTOR_TYPES.AGENT;
    if (CUSTOMER_STATUS_IDS.has(id)) return ACTOR_TYPES.CUSTOMER;
    return ACTOR_TYPES.SYSTEM;
}

function normalizeActorType(value) {
    const key = String(value || '').trim().toLowerCase();
    if (key === 'admin' || key === 'agent' || key === 'driver' || key === 'customer' || key === 'system') {
        return key;
    }
    return null;
}

function personName(firstName, lastName) {
    return [firstName, lastName].map((p) => String(p || '').trim()).filter(Boolean).join(' ');
}

function combineHistoryAt(row) {
    if (!row) return null;
    if (row.createdAt) return row.createdAt;
    const date = row.date ? String(row.date).slice(0, 10) : '';
    const timeRaw = row.time != null ? String(row.time) : '';
    const time = timeRaw.length >= 8 ? timeRaw.slice(0, 8) : timeRaw;
    if (date && time) return `${date}T${time}`;
    return date || null;
}

function presentLastStatusChange({ history, bookingStatusId, bookingUpdatedAt } = {}) {
    const storedType = normalizeActorType(history && history.actorType);
    const type =
        storedType ||
        inferActorFromStatusId(
            (history && history.bookingStatusId) || bookingStatusId
        );
    const name = personName(
        history && (history.actorFirstName || history.actor?.firstName),
        history && (history.actorLastName || history.actor?.lastName)
    );
    return {
        actorType: type,
        actorLabel: actorLabel(type),
        actorName: name || null,
        actorUserId: history && history.actorUserId != null ? Number(history.actorUserId) : null,
        at: combineHistoryAt(history) || bookingUpdatedAt || null,
        inferred: !storedType,
    };
}

module.exports = {
    DRIVER_STATUS_IDS,
    AGENT_STATUS_IDS,
    CUSTOMER_STATUS_IDS,
    inferActorFromStatusId,
    normalizeActorType,
    personName,
    combineHistoryAt,
    presentLastStatusChange,
};

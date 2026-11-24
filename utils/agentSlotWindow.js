'use strict';

/**
 * Agent home slots (GET /agent/agentBookingFilters?filterType=slots): which hour slot a
 * booking belongs to. The slot query reads all slots of the day at once, and this is the
 * JS twin of the time-window part of agentSlotWhere (controllers/Agent/agents.js): MySQL
 * TIME comparison, NULL never fits.
 */

/** Seconds since midnight of a MySQL TIME value ("HH:MM" or "HH:MM:SS"); null when absent. */
function timeOfDaySeconds(value) {
    if (value == null || value === '') return null;
    const match = /^(-?)(\d+):(\d{2})(?::(\d{2}))?/.exec(String(value));
    if (!match) return null;
    const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] || 0);
    return match[1] === '-' ? -seconds : seconds;
}

/**
 * Whether a booking that already matched the day's slot query (shop, phase and date) fits
 * the slot [slotFrom, slotTo]: pickup phase → its collection window; facility+ phase (only
 * when a day is given, as in agentSlotWhere) → its delivery window.
 * @param {object} plain booking row (plain object)
 * @param {string} slotFrom "HH:MM"
 * @param {string} slotTo "HH:MM"
 * @param {{ withDay: boolean, pickupStatuses: number[], postPickupStatuses: number[] }} rules
 */
function bookingFitsAgentSlot(plain, slotFrom, slotTo, { withDay, pickupStatuses, postPickupStatuses }) {
    const status = Number(plain.bookingStatusId);
    let fromValue;
    let toValue;
    if (pickupStatuses.includes(status)) {
        fromValue = plain.collectionTimeFrom;
        // The slot query selects the column as "collectiontimeTo" (MySQL names are
        // case-insensitive; the response key is kept as the app reads it).
        toValue = plain.collectionTimeTo !== undefined ? plain.collectionTimeTo : plain.collectiontimeTo;
    } else if (withDay && postPickupStatuses.includes(status)) {
        fromValue = plain.deliveryTimeFrom;
        toValue = plain.deliveryTimeTo;
    } else {
        return false;
    }
    const from = timeOfDaySeconds(fromValue);
    const to = timeOfDaySeconds(toValue);
    if (from == null || to == null) return false;
    return from >= timeOfDaySeconds(slotFrom) && to <= timeOfDaySeconds(slotTo);
}

module.exports = { timeOfDaySeconds, bookingFitsAgentSlot };

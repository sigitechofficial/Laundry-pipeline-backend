'use strict';

/**
 * Which pickup / delivery slots a zone can actually serve.
 *
 * A slot is offered (and accepted at booking) only when at least one shop in the
 * zone that can take new orders works that whole slot on that day. "Can take new
 * orders" is the broadcast's own rule (customerOrderService.bookingEventSentCheckTheShops):
 * active shop address, owner account not blocked, not on marketplace hold, and —
 * when the order's services are known — offering every one of them. Working hours
 * are the shop's for that weekday (day off = no window).
 *
 * Before this, slots came from platform hours alone: a customer could book a 07:00
 * pickup in a zone whose shops open at 09:00, and the order then sat with no shop
 * able to take it (released=false reason=no_eligible_recipient).
 */
const { Op } = require('sequelize');

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function toMinutes(value) {
    if (value == null) return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(String(value).trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 24 || min > 59) return null;
    return h * 60 + min;
}

/**
 * True when [from, to) on that day lies inside at least one shop window.
 * Times are wall-clock "HH:mm[:ss]" in the zone's operational time zone, the
 * same clock slots and shop hours are kept in.
 * @param {string} from
 * @param {string} to
 * @param {Array<{ openTime: string, closeTime: string }>} windows
 */
function slotFitsAnyWindow(from, to, windows) {
    const start = toMinutes(from);
    const end = toMinutes(to);
    if (start == null || end == null || end <= start) return false;
    return (windows || []).some((w) => {
        const open = toMinutes(w.openTime);
        const close = toMinutes(w.closeTime);
        return open != null && close != null && open < close && start >= open && end <= close;
    });
}

/**
 * Working-hours windows, per weekday, of the zone's shops that can take new orders.
 * @param {number} zoneId
 * @param {{ serviceIds?: number[] }} [opts] when given, only shops offering all of them
 * @returns {Promise<{ shopCount: number, windowsByDay: Map<string, Array<{ shopUserId: number, openTime: string, closeTime: string }>> }>}
 */
async function servableShopWindows(zoneId, { serviceIds = [] } = {}) {
    const {
        addressDb,
        users,
        agentSelectServices,
        bussinessInformation,
        bussinessWorkingHours,
    } = require('../models');
    const shopAssignmentPolicyService = require('../services/Admin/shopAssignmentPolicyService');

    const required = [...new Set((serviceIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    const shops = await addressDb.findAll({
        where: { zoneId, addressType: 'LaundaryShopAddress', status: true },
        attributes: ['id', 'userId'],
        include: [{
            model: users,
            attributes: ['id', 'status'],
            required: true,
            include: required.length
                ? [{
                    model: agentSelectServices,
                    as: 'agentServices',
                    where: { serviceId: { [Op.in]: required }, status: true },
                    attributes: ['serviceId'],
                    required: false,
                }]
                : [],
        }],
    });
    const { holdExcluded } = await shopAssignmentPolicyService.getRestrictedShopUserIds();
    const eligible = shops.filter((s) => {
        if (!s.user || s.user.status === false) return false;
        if (holdExcluded.has(Number(s.userId))) return false;
        if (!required.length) return true;
        const offered = new Set((s.user.agentServices || []).map((a) => Number(a.serviceId)));
        return required.every((id) => offered.has(id));
    });

    const windowsByDay = new Map(DAY_NAMES.map((d) => [d, []]));
    if (!eligible.length) return { shopCount: 0, windowsByDay };

    // Hours are kept per owner (userId) or, for older shops, per business record.
    const userIds = eligible.map((s) => Number(s.userId));
    const businesses = await bussinessInformation.findAll({
        where: { shopAddressId: { [Op.in]: eligible.map((s) => s.id) } },
        attributes: ['id', 'shopAddressId'],
    });
    const ownerByBusiness = new Map(
        businesses.map((b) => [Number(b.id), Number(eligible.find((s) => s.id === b.shopAddressId).userId)])
    );
    const rows = await bussinessWorkingHours.findAll({
        where: {
            [Op.or]: [
                { userId: { [Op.in]: userIds } },
                ...(ownerByBusiness.size ? [{ bussinessInformationId: { [Op.in]: [...ownerByBusiness.keys()] } }] : []),
            ],
        },
        attributes: ['userId', 'bussinessInformationId', 'dayOfWeek', 'openTime', 'closeTime', 'status'],
    });

    // A shop's own (userId) row for a day wins over its business-record row.
    const byShopDay = new Map();
    for (const row of rows) {
        const owner = row.userId != null && userIds.includes(Number(row.userId))
            ? Number(row.userId)
            : ownerByBusiness.get(Number(row.bussinessInformationId));
        if (owner == null) continue;
        const day = String(row.dayOfWeek || '').toLowerCase();
        const key = `${owner}|${day}`;
        const own = row.userId != null && Number(row.userId) === owner;
        if (!byShopDay.has(key) || own) byShopDay.set(key, row);
    }
    for (const [key, row] of byShopDay) {
        if (!row.status) continue; // day off
        const [owner, day] = key.split('|');
        if (!windowsByDay.has(day)) continue;
        windowsByDay.get(day).push({ shopUserId: Number(owner), openTime: row.openTime, closeTime: row.closeTime });
    }
    return { shopCount: eligible.length, windowsByDay };
}

/**
 * Can a shop in the zone serve this slot? (The booking guard.)
 * @param {number} zoneId
 * @param {string} dayOfWeek lower-case weekday name of the slot's date (zone time)
 */
async function canZoneServeSlot(zoneId, dayOfWeek, from, to, { serviceIds = [] } = {}) {
    const { windowsByDay } = await servableShopWindows(zoneId, { serviceIds });
    return slotFitsAnyWindow(from, to, windowsByDay.get(String(dayOfWeek).toLowerCase()) || []);
}

module.exports = { DAY_NAMES, slotFitsAnyWindow, servableShopWindows, canZoneServeSlot };

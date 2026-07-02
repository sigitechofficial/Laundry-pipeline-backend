const redisCli = require("../redis/redis");

/** Agent considered online while app is active (refreshed on getBookingHome / joinRoom). */
const AGENT_ONLINE_TTL_SECONDS = 30 * 60;

const KEY_PREFIX = "agent-online:";
const ZONE_PREFIX = "agent-online-zone:";

function agentKey(userId) {
    return `${KEY_PREFIX}${userId}`;
}

function zoneKey(zoneId) {
    return `${ZONE_PREFIX}${zoneId}`;
}

/**
 * Mark agent app as active — shop can receive after-hours queued bookings.
 * @param {number|string} agentUserId
 * @param {number|string} [zoneId]
 */
async function markAgentOnline(agentUserId, zoneId) {
    if (!agentUserId) return;
    try {
        const uid = String(agentUserId);
        await redisCli.setEx(agentKey(uid), AGENT_ONLINE_TTL_SECONDS, "1");
        if (zoneId != null && zoneId !== "") {
            const zKey = zoneKey(zoneId);
            await redisCli.sAdd(zKey, uid);
            await redisCli.expire(zKey, AGENT_ONLINE_TTL_SECONDS);
        }
    } catch (err) {
        console.error("[agentOnlineStatus] markAgentOnline error:", err.message);
    }
}

/**
 * @param {number|string} agentUserId
 */
async function isAgentOnline(agentUserId) {
    if (!agentUserId) return false;
    try {
        const val = await redisCli.get(agentKey(agentUserId));
        return val != null;
    } catch (err) {
        console.error("[agentOnlineStatus] isAgentOnline error:", err.message);
        return false;
    }
}

/**
 * Online agent user IDs in a zone (still holding individual online keys).
 * @param {number|string} zoneId
 * @returns {Promise<number[]>}
 */
async function getOnlineAgentUserIdsInZone(zoneId) {
    if (zoneId == null || zoneId === "") return [];
    try {
        const members = await redisCli.sMembers(zoneKey(zoneId));
        if (!members?.length) return [];

        const online = [];
        for (const uid of members) {
            if (await isAgentOnline(uid)) {
                online.push(Number(uid));
            }
        }
        return online.filter((id) => Number.isFinite(id) && id > 0);
    } catch (err) {
        console.error("[agentOnlineStatus] getOnlineAgentUserIdsInZone error:", err.message);
        return [];
    }
}

/**
 * @param {number|string} zoneId
 */
async function isAnyAgentOnlineInZone(zoneId) {
    const ids = await getOnlineAgentUserIdsInZone(zoneId);
    return ids.length > 0;
}

module.exports = {
    AGENT_ONLINE_TTL_SECONDS,
    markAgentOnline,
    isAgentOnline,
    getOnlineAgentUserIdsInZone,
    isAnyAgentOnlineInZone,
};

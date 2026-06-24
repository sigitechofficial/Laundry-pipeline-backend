/**
 * Zone agent commission: admin sets what % of order total the shop/agent earns.
 * Platform cut (zoneAdminCommission amount) = remainder.
 */

const DEFAULT_PLATFORM_COMMISSION_PERCENT = 20;

function clampPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.min(100, Math.max(0, n));
}

/**
 * Resolve agent commission % from zone row.
 * Prefers agentCommissionPercent; falls back to 100 − zoneAdminComission (legacy).
 */
function resolveAgentCommissionPercent(zone) {
    if (!zone) {
        return 100 - DEFAULT_PLATFORM_COMMISSION_PERCENT;
    }

    if (
        zone.agentCommissionPercent != null &&
        zone.agentCommissionPercent !== ""
    ) {
        const pct = clampPercent(zone.agentCommissionPercent);
        if (pct != null) return pct;
    }

    const platformPct = clampPercent(zone.zoneAdminComission);
    if (platformPct != null) {
        return 100 - platformPct;
    }

    return 100 - DEFAULT_PLATFORM_COMMISSION_PERCENT;
}

/**
 * @param {number} totalOrderAmount
 * @param {number} agentCommissionPercent
 */
function calculateAgentCommissionAmounts(totalOrderAmount, agentCommissionPercent) {
    const total = Number(totalOrderAmount) || 0;
    const agentPct = clampPercent(agentCommissionPercent) ?? 0;
    const agentEarning = parseFloat(((total * agentPct) / 100).toFixed(2));
    const platformCommissionAmount = parseFloat((total - agentEarning).toFixed(2));

    return {
        agentCommissionPercent: agentPct,
        agentEarning,
        platformCommissionAmount,
    };
}

/**
 * Sync zoneAdminComission (platform %) when admin sets agent %.
 * @param {object} data - mutable zone payload
 */
function applyAgentCommissionToZonePayload(data) {
    if (!data || typeof data !== "object") return data;

    if (
        data.agentCommissionPercent !== undefined &&
        data.agentCommissionPercent !== null &&
        data.agentCommissionPercent !== ""
    ) {
        const agentPct = clampPercent(data.agentCommissionPercent);
        if (agentPct == null) {
            throw new Error("Invalid agent commission percentage");
        }
        data.agentCommissionPercent = agentPct;
        data.zoneAdminComission = 100 - agentPct;
        return data;
    }

    if (
        data.zoneAdminComission !== undefined &&
        data.zoneAdminComission !== null &&
        data.zoneAdminComission !== ""
    ) {
        const platformPct = clampPercent(data.zoneAdminComission);
        if (platformPct == null) {
            throw new Error("Invalid zone commission percentage");
        }
        data.zoneAdminComission = platformPct;
        data.agentCommissionPercent = 100 - platformPct;
    }

    return data;
}

module.exports = {
    DEFAULT_PLATFORM_COMMISSION_PERCENT,
    clampPercent,
    resolveAgentCommissionPercent,
    calculateAgentCommissionAmounts,
    applyAgentCommissionToZonePayload,
};

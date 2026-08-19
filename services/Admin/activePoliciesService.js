const {
    policy,
    cancellationPolicyConfig,
    reschedulePolicyConfig,
    noShowPolicyConfig
} = require('../../models');
const { Op } = require('sequelize');

/**
 * Active Policies Service
 * Returns the single currently-effective policy per type, scoped to a zone.
 *
 * Selection rules (applied in order):
 *  1. isActive = true
 *  2. zoneId matches the booking's zone
 *  3. effectiveFrom <= NOW  (or effectiveFrom IS NULL  → always started)
 *  4. effectiveTo   >= NOW  (or effectiveTo   IS NULL  → never expires)
 *  5. Prefer isDefault = true; break ties by latest effectiveFrom, then latest createdAt
 */
class ActivePoliciesService {

    /**
     * Build a Sequelize where-clause that picks policies effective RIGHT NOW for a zone.
     * @param {string} type   - 'cancellation' | 'reschedule' | 'no_show'
     * @param {number} zoneId - the zone to scope the lookup to
     */
    _normalizeZoneId(zoneId) {
        if (zoneId === null || zoneId === undefined || zoneId === '') {
            return null;
        }
        const parsed = Number(zoneId);
        return Number.isFinite(parsed) ? parsed : null;
    }

    _nowWhere(type, zoneId = null, { globalOnly = false } = {}) {
        const now = new Date();
        const normalizedZoneId = this._normalizeZoneId(zoneId);
        return {
            type,
            isActive: true,
            ...(globalOnly
                ? { zoneId: null }
                : (normalizedZoneId !== null ? { zoneId: normalizedZoneId } : { zoneId: null })),
            [Op.and]: [
                {
                    [Op.or]: [
                        { effectiveFrom: null },
                        { effectiveFrom: { [Op.lte]: now } }
                    ]
                },
                {
                    [Op.or]: [
                        { effectiveTo: null },
                        { effectiveTo: { [Op.gte]: now } }
                    ]
                }
            ]
        };
    }

    /**
     * Get the currently effective cancellation policy for a zone.
     * @param {number} zoneId
     * @returns {Object|null}
     */
    async getActiveCancellationPolicy(zoneId) {
        const normalizedZoneId = this._normalizeZoneId(zoneId);
        const where = this._nowWhere('cancellation', normalizedZoneId);
        let result = await policy.findOne({
            where,
            include: [
                {
                    model: cancellationPolicyConfig,
                    as: 'cancellationConfig',
                    required: false
                }
            ],
            order: [
                ['isDefault', 'DESC'],
                ['effectiveFrom', 'DESC'],
                ['createdAt', 'DESC']
            ]
        });
        // Fallback: when zone-specific policy is not found, use global (zoneId null)
        if (!result && normalizedZoneId !== null) {
            result = await policy.findOne({
                where: this._nowWhere('cancellation', null, { globalOnly: true }),
                include: [
                    {
                        model: cancellationPolicyConfig,
                        as: 'cancellationConfig',
                        required: false
                    }
                ],
                order: [
                    ['isDefault', 'DESC'],
                    ['effectiveFrom', 'DESC'],
                    ['createdAt', 'DESC']
                ]
            });
        }
        return result;
    }

    /**
     * Get the currently effective reschedule policy for a zone.
     * @param {number} zoneId
     * @returns {Object|null}
     */
    async getActiveReschedulePolicy(zoneId) {
        const normalizedZoneId = this._normalizeZoneId(zoneId);
        let result = await policy.findOne({
            where: this._nowWhere('reschedule', normalizedZoneId),
            include: [
                {
                    model: reschedulePolicyConfig,
                    as: 'rescheduleConfig',
                    required: false
                }
            ],
            order: [
                ['isDefault', 'DESC'],
                ['effectiveFrom', 'DESC'],
                ['createdAt', 'DESC']
            ]
        });
        if (!result && normalizedZoneId !== null) {
            result = await policy.findOne({
                where: this._nowWhere('reschedule', null, { globalOnly: true }),
                include: [
                    {
                        model: reschedulePolicyConfig,
                        as: 'rescheduleConfig',
                        required: false
                    }
                ],
                order: [
                    ['isDefault', 'DESC'],
                    ['effectiveFrom', 'DESC'],
                    ['createdAt', 'DESC']
                ]
            });
        }
        return result;
    }

    /**
     * Get the currently effective no-show policy for a zone.
     * @param {number} zoneId
     * @returns {Object|null}
     */
    async getActiveNoShowPolicy(zoneId) {
        const normalizedZoneId = this._normalizeZoneId(zoneId);
        let result = await policy.findOne({
            where: this._nowWhere('no_show', normalizedZoneId),
            include: [
                {
                    model: noShowPolicyConfig,
                    as: 'noShowConfig',
                    required: false
                }
            ],
            order: [
                ['isDefault', 'DESC'],
                ['effectiveFrom', 'DESC'],
                ['createdAt', 'DESC']
            ]
        });
        if (!result && normalizedZoneId !== null) {
            result = await policy.findOne({
                where: this._nowWhere('no_show', null, { globalOnly: true }),
                include: [
                    {
                        model: noShowPolicyConfig,
                        as: 'noShowConfig',
                        required: false
                    }
                ],
                order: [
                    ['isDefault', 'DESC'],
                    ['effectiveFrom', 'DESC'],
                    ['createdAt', 'DESC']
                ]
            });
        }
        return result;
    }

    /**
     * Get all currently-effective policies for a zone in one call.
     * @param {number} zoneId
     * @returns {{ activeCancellationPolicy, activeReschedulePolicy, activeNoShowPolicy }}
     */
    async getActivePolicies(zoneId) {
        const [activeCancellationPolicy, activeReschedulePolicy, activeNoShowPolicy] = await Promise.all([
            this.getActiveCancellationPolicy(zoneId),
            this.getActiveReschedulePolicy(zoneId),
            this.getActiveNoShowPolicy(zoneId)
        ]);

        return {
            activeCancellationPolicy: activeCancellationPolicy || null,
            activeReschedulePolicy:   activeReschedulePolicy   || null,
            activeNoShowPolicy:       activeNoShowPolicy        || null
        };
    }
}

module.exports = new ActivePoliciesService();

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
    _nowWhere(type, zoneId) {
        const now = new Date();
        return {
            type,
            isActive: true,
            zoneId,
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
        return policy.findOne({
            where: this._nowWhere('cancellation', zoneId),
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

    /**
     * Get the currently effective reschedule policy for a zone.
     * @param {number} zoneId
     * @returns {Object|null}
     */
    async getActiveReschedulePolicy(zoneId) {
        return policy.findOne({
            where: this._nowWhere('reschedule', zoneId),
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

    /**
     * Get the currently effective no-show policy for a zone.
     * @param {number} zoneId
     * @returns {Object|null}
     */
    async getActiveNoShowPolicy(zoneId) {
        return policy.findOne({
            where: this._nowWhere('no_show', zoneId),
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

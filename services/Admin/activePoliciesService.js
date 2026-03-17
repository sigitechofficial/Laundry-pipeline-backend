const {
    policy,
    cancellationPolicyConfig,
    reschedulePolicyConfig,
    noShowPolicyConfig
} = require('../../models');
const { Op } = require('sequelize');

/**
 * Active Policies Service
 * Returns the single currently-effective policy per type.
 *
 * Selection rules (applied in order):
 *  1. isActive = true
 *  2. effectiveFrom <= NOW  (or effectiveFrom IS NULL  → always started)
 *  3. effectiveTo   >= NOW  (or effectiveTo   IS NULL  → never expires)
 *  4. Prefer isDefault = true; break ties by latest effectiveFrom, then latest createdAt
 */
class ActivePoliciesService {

    /**
     * Build a Sequelize where-clause that picks policies effective RIGHT NOW.
     * @param {string} type  - 'cancellation' | 'reschedule' | 'no_show'
     */
    _nowWhere(type) {
        const now = new Date();
        return {
            type,
            isActive: true,
            [Op.and]: [
                // effectiveFrom is null OR effectiveFrom <= now
                {
                    [Op.or]: [
                        { effectiveFrom: null },
                        { effectiveFrom: { [Op.lte]: now } }
                    ]
                },
                // effectiveTo is null OR effectiveTo >= now
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
     * Get the currently effective cancellation policy.
     * Prefers default; falls back to latest effectiveFrom / createdAt.
     * @returns {Object|null}
     */
    async getActiveCancellationPolicy() {
        return policy.findOne({
            where: this._nowWhere('cancellation'),
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
     * Get the currently effective reschedule policy.
     * Prefers default; falls back to latest effectiveFrom / createdAt.
     * @returns {Object|null}
     */
    async getActiveReschedulePolicy() {
        return policy.findOne({
            where: this._nowWhere('reschedule'),
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
     * Get the currently effective no-show policy.
     * Prefers default; falls back to latest effectiveFrom / createdAt.
     * @returns {Object|null}
     */
    async getActiveNoShowPolicy() {
        return policy.findOne({
            where: this._nowWhere('no_show'),
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
     * Get all currently-effective policies in one call.
     * @returns {{ activeCancellationPolicy, activeReschedulePolicy, activeNoShowPolicy }}
     */
    async getActivePolicies() {
        const [activeCancellationPolicy, activeReschedulePolicy, activeNoShowPolicy] = await Promise.all([
            this.getActiveCancellationPolicy(),
            this.getActiveReschedulePolicy(),
            this.getActiveNoShowPolicy()
        ]);

        return {
            activeCancellationPolicy: activeCancellationPolicy || null,
            activeReschedulePolicy: activeReschedulePolicy || null,
            activeNoShowPolicy: activeNoShowPolicy || null
        };
    }
}

module.exports = new ActivePoliciesService();

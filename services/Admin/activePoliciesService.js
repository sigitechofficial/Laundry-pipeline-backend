const {
    policy,
    cancellationPolicyConfig,
    reschedulePolicyConfig,
    noShowPolicyConfig
} = require('../../models');

/**
 * Active Policies Service
 * Returns the single active (and preferred default) policy per type:
 * - Active cancellation policy
 * - Active reschedule policy
 * - Active no-show policy
 */
class ActivePoliciesService {

    /**
     * Get the active cancellation policy (isActive: true, prefers default)
     * @returns {Object|null} Policy with cancellationConfig, or null
     */
    async getActiveCancellationPolicy() {
        return policy.findOne({
            where: { type: 'cancellation', isActive: true },
            include: [
                {
                    model: cancellationPolicyConfig,
                    as: 'cancellationConfig',
                    required: false
                }
            ],
            order: [['isDefault', 'DESC'], ['createdAt', 'DESC']]
        });
    }

    /**
     * Get the active reschedule policy (isActive: true, prefers default)
     * @returns {Object|null} Policy with rescheduleConfig, or null
     */
    async getActiveReschedulePolicy() {
        return policy.findOne({
            where: { type: 'reschedule', isActive: true },
            include: [
                {
                    model: reschedulePolicyConfig,
                    as: 'rescheduleConfig',
                    required: false
                }
            ],
            order: [['isDefault', 'DESC'], ['createdAt', 'DESC']]
        });
    }

    /**
     * Get the active no-show policy (isActive: true, prefers default)
     * @returns {Object|null} Policy with noShowPolicyConfig, or null
     */
    async getActiveNoShowPolicy() {
        return policy.findOne({
            where: { type: 'no_show', isActive: true },
            include: [
                {
                    model: noShowPolicyConfig,
                    required: false
                }
            ],
            order: [['isDefault', 'DESC'], ['createdAt', 'DESC']]
        });
    }

    /**
     * Get all active policies in one call: cancellation, reschedule, no-show
     * @returns {Object} { activeCancellationPolicy, activeReschedulePolicy, activeNoShowPolicy }
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

const { policy, reschedulePolicyConfig } = require('../../models');
const { NotFoundError, ConflictError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { Op } = require('sequelize');

/**
 * Reschedule Policy Management Service
 * Handles reschedule policies with effectiveFrom / effectiveTo scheduling.
 *
 * Rules:
 *  - effectiveFrom: date policy starts being applicable (null = from the beginning)
 *  - effectiveTo  : date policy stops being applicable (null = never expires)
 *  - isActive     : manual on/off switch (false = force-disabled regardless of dates)
 *  - isDefault    : tie-breaker when multiple policies are valid at the same moment
 */
class ReschedulePolicyService {

    // ─── helpers ────────────────────────────────────────────────────────────────

    _validateDateRange(effectiveFrom, effectiveTo) {
        if (effectiveFrom && effectiveTo) {
            const from = new Date(effectiveFrom);
            const to   = new Date(effectiveTo);
            if (from >= to) {
                throw new ValidationError("effectiveFrom must be earlier than effectiveTo");
            }
        }
    }

    async _checkOverlap(effectiveFrom, effectiveTo, excludeId = null) {
        if (!effectiveFrom && !effectiveTo) return;

        const overlapping = await policy.findAll({
            where: {
                type: 'reschedule',
                isActive: true,
                ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
                [Op.and]: [
                    effectiveTo
                        ? {
                              [Op.or]: [
                                  { effectiveFrom: null },
                                  { effectiveFrom: { [Op.lt]: new Date(effectiveTo) } }
                              ]
                          }
                        : {},
                    effectiveFrom
                        ? {
                              [Op.or]: [
                                  { effectiveTo: null },
                                  { effectiveTo: { [Op.gt]: new Date(effectiveFrom) } }
                              ]
                          }
                        : {}
                ]
            },
            attributes: ['id', 'name', 'effectiveFrom', 'effectiveTo']
        });

        if (overlapping.length > 0) {
            const names = overlapping
                .map(p => `"${p.name}" (${p.effectiveFrom ?? '∞'} → ${p.effectiveTo ?? '∞'})`)
                .join(', ');
            throw new ConflictError(
                `Date window overlaps with existing active reschedule ${overlapping.length > 1 ? 'policies' : 'policy'}: ${names}. ` +
                `Adjust effectiveFrom / effectiveTo or deactivate the conflicting policy first.`
            );
        }
    }

    _nowWhere() {
        const now = new Date();
        return {
            type: 'reschedule',
            isActive: true,
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

    // ─── CRUD ────────────────────────────────────────────────────────────────────

    /**
     * Create Reschedule Policy with Configuration.
     */
    async createReschedulePolicy(data) {
        const {
            name,
            description,
            createdBy,
            effectiveFrom,
            effectiveTo,
            isActive,
            isDefault,
            ...configData
        } = data;

        if (!name) {
            throw new ValidationError("Policy name is required");
        }

        this._validateDateRange(effectiveFrom, effectiveTo);

        if (isActive !== false) {
            await this._checkOverlap(effectiveFrom, effectiveTo);
        }

        if (isDefault) {
            await policy.update(
                { isDefault: false },
                { where: { type: 'reschedule', isDefault: true } }
            );
        }

        const newPolicy = await policy.create({
            name,
            type: 'reschedule',
            description,
            isActive:      isActive ?? true,
            isDefault:     isDefault ?? false,
            effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null,
            effectiveTo:   effectiveTo   ? new Date(effectiveTo)   : null,
            createdBy
        });

        await reschedulePolicyConfig.create({
            policyId: newPolicy.id,
            ...configData
        });

        return await this.getReschedulePolicyById(newPolicy.id);
    }

    /**
     * Get Reschedule Policy by ID with Configuration.
     */
    async getReschedulePolicyById(policyId) {
        const policyData = await policy.findByPk(policyId, {
            include: [
                {
                    model: reschedulePolicyConfig,
                    as: 'rescheduleConfig',
                    required: false
                }
            ]
        });

        if (!policyData) {
            throw new NotFoundError("Reschedule policy not found");
        }

        if (policyData.type !== 'reschedule') {
            throw new ValidationError("This policy is not a reschedule policy");
        }

        return policyData;
    }

    /**
     * Get All Reschedule Policies with Filters.
     * Pass `status: 'active_now'` to return only currently-effective policies.
     */
    async getAllReschedulePolicies(filters = {}) {
        const {
            isActive,
            isDefault,
            status,
            page  = 1,
            limit = 10
        } = filters;

        let whereClause = { type: 'reschedule' };

        if (status === 'active_now') {
            whereClause = this._nowWhere();
        } else {
            if (isActive  !== undefined) whereClause.isActive  = isActive;
            if (isDefault !== undefined) whereClause.isDefault = isDefault;
        }

        const offset = (page - 1) * limit;

        const { count, rows } = await policy.findAndCountAll({
            where: whereClause,
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
            ],
            limit:  parseInt(limit),
            offset: parseInt(offset)
        });

        return {
            policies: rows,
            pagination: {
                total: count,
                page:  parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(count / limit)
            }
        };
    }

    /**
     * Update Reschedule Policy.
     */
    async updateReschedulePolicy(policyId, updateData, updatedBy) {
        const policyData = await policy.findByPk(policyId);

        if (!policyData) {
            throw new NotFoundError("Reschedule policy not found");
        }

        if (policyData.type !== 'reschedule') {
            throw new ValidationError("This policy is not a reschedule policy");
        }

        const {
            name,
            description,
            isActive,
            isDefault,
            effectiveFrom,
            effectiveTo,
            ...configData
        } = updateData;

        const finalFrom = effectiveFrom !== undefined
            ? (effectiveFrom ? new Date(effectiveFrom) : null)
            : policyData.effectiveFrom;
        const finalTo   = effectiveTo !== undefined
            ? (effectiveTo   ? new Date(effectiveTo)   : null)
            : policyData.effectiveTo;

        this._validateDateRange(finalFrom, finalTo);

        const willBeActive = isActive !== undefined ? isActive : policyData.isActive;
        if (willBeActive && (effectiveFrom !== undefined || effectiveTo !== undefined)) {
            await this._checkOverlap(finalFrom, finalTo, policyId);
        }

        if (isDefault) {
            await policy.update(
                { isDefault: false },
                {
                    where: {
                        type: 'reschedule',
                        isDefault: true,
                        id: { [Op.ne]: policyId }
                    }
                }
            );
        }

        const policyUpdateData = {};
        if (name          !== undefined) policyUpdateData.name          = name;
        if (description   !== undefined) policyUpdateData.description   = description;
        if (isActive      !== undefined) policyUpdateData.isActive      = isActive;
        if (isDefault     !== undefined) policyUpdateData.isDefault     = isDefault;
        if (effectiveFrom !== undefined) policyUpdateData.effectiveFrom = finalFrom;
        if (effectiveTo   !== undefined) policyUpdateData.effectiveTo   = finalTo;

        if (Object.keys(policyUpdateData).length > 0) {
            policyUpdateData.updatedBy = updatedBy;
            await policyData.update(policyUpdateData);
        }

        if (Object.keys(configData).length > 0) {
            const existingConfig = await reschedulePolicyConfig.findOne({ where: { policyId } });
            if (existingConfig) {
                await existingConfig.update(configData);
            } else {
                await reschedulePolicyConfig.create({ policyId, ...configData });
            }
        }

        return await this.getReschedulePolicyById(policyId);
    }

    /**
     * Get the currently-effective reschedule policy.
     */
    async getActiveReschedulePolicy() {
        const policyData = await policy.findOne({
            where: this._nowWhere(),
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

        if (!policyData) {
            throw new NotFoundError("No active reschedule policy found");
        }

        return policyData;
    }

    /**
     * Delete Reschedule Policy.
     */
    async deleteReschedulePolicy(policyId) {
        const policyData = await policy.findByPk(policyId);

        if (!policyData) {
            throw new NotFoundError("Reschedule policy not found");
        }

        if (policyData.type !== 'reschedule') {
            throw new ValidationError("This policy is not a reschedule policy");
        }

        if (policyData.isDefault) {
            throw new ConflictError("Cannot delete default reschedule policy. Please set another policy as default first.");
        }

        await policyData.destroy();

        return { message: "Reschedule policy deleted successfully", policyId };
    }

    /**
     * Set Default Reschedule Policy.
     */
    async setDefaultReschedulePolicy(policyId, updatedBy) {
        const policyData = await policy.findByPk(policyId);

        if (!policyData) {
            throw new NotFoundError("Reschedule policy not found");
        }

        if (policyData.type !== 'reschedule') {
            throw new ValidationError("This policy is not a reschedule policy");
        }

        if (!policyData.isActive) {
            throw new ValidationError("Cannot set inactive policy as default");
        }

        await policy.update(
            { isDefault: false },
            {
                where: {
                    type: 'reschedule',
                    isDefault: true,
                    id: { [Op.ne]: policyId }
                }
            }
        );

        await policyData.update({ isDefault: true, updatedBy });

        return await this.getReschedulePolicyById(policyId);
    }

    /**
     * Toggle Reschedule Policy Status.
     */
    async toggleReschedulePolicyStatus(policyId, updatedBy) {
        const policyData = await policy.findByPk(policyId);

        if (!policyData) {
            throw new NotFoundError("Reschedule policy not found");
        }

        if (policyData.type !== 'reschedule') {
            throw new ValidationError("This policy is not a reschedule policy");
        }

        if (policyData.isDefault && policyData.isActive) {
            const alternative = await policy.findOne({
                where: {
                    type: 'reschedule',
                    isActive: true,
                    isDefault: false,
                    id: { [Op.ne]: policyId }
                }
            });
            if (alternative) {
                await alternative.update({ isDefault: true });
            }
        }

        await policyData.update({ isActive: !policyData.isActive, updatedBy });

        return await this.getReschedulePolicyById(policyId);
    }

    /**
     * Get Reschedule Policy Statistics.
     */
    async getReschedulePolicyStatistics() {
        const totalPolicies  = await policy.count({ where: { type: 'reschedule' } });
        const activePolicies = await policy.count({ where: { type: 'reschedule', isActive: true } });

        const defaultPolicy = await policy.findOne({
            where: this._nowWhere(),
            order: [['isDefault', 'DESC'], ['effectiveFrom', 'DESC']],
            attributes: ['id', 'name', 'isActive', 'isDefault', 'effectiveFrom', 'effectiveTo']
        });

        return {
            totalReschedulePolicies:    totalPolicies,
            activeReschedulePolicies:   activePolicies,
            inactiveReschedulePolicies: totalPolicies - activePolicies,
            defaultReschedulePolicy:    defaultPolicy
        };
    }
}

module.exports = new ReschedulePolicyService();

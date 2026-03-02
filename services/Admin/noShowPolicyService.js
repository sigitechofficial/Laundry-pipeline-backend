const { policy, noShowPolicyConfig } = require('../../models');
const { NotFoundError, ConflictError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { Op } = require('sequelize');

/**
 * No-Show Policy Management Service
 * Handles no-show policies with effectiveFrom / effectiveTo scheduling.
 *
 * Rules:
 *  - effectiveFrom: date policy starts being applicable (null = from the beginning)
 *  - effectiveTo  : date policy stops being applicable (null = never expires)
 *  - isActive     : manual on/off switch (false = force-disabled regardless of dates)
 *  - isDefault    : tie-breaker when multiple policies are valid at the same moment
 */
class NoShowPolicyService {

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
                type: 'no_show',
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
                `Date window overlaps with existing active no-show ${overlapping.length > 1 ? 'policies' : 'policy'}: ${names}. ` +
                `Adjust effectiveFrom / effectiveTo or deactivate the conflicting policy first.`
            );
        }
    }

    _nowWhere() {
        const now = new Date();
        return {
            type: 'no_show',
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
     * Create No-Show Policy with Configuration.
     */
    async createNoShowPolicy(data) {
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
                { where: { type: 'no_show', isDefault: true } }
            );
        }

        const newPolicy = await policy.create({
            name,
            type: 'no_show',
            description,
            isActive:      isActive ?? true,
            isDefault:     isDefault ?? false,
            effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null,
            effectiveTo:   effectiveTo   ? new Date(effectiveTo)   : null,
            createdBy
        });

        await noShowPolicyConfig.create({
            policyId: newPolicy.id,
            ...configData
        });

        return await this.getNoShowPolicyById(newPolicy.id);
    }

    /**
     * Get No-Show Policy by ID with Configuration.
     */
    async getNoShowPolicyById(policyId) {
        const policyData = await policy.findByPk(policyId, {
            include: [
                {
                    model: noShowPolicyConfig,
                    required: false
                }
            ]
        });

        if (!policyData) {
            throw new NotFoundError("No-show policy not found");
        }

        if (policyData.type !== 'no_show') {
            throw new ValidationError("This policy is not a no-show policy");
        }

        return policyData;
    }

    /**
     * Get All No-Show Policies with Filters.
     * Pass `status: 'active_now'` to return only currently-effective policies.
     */
    async getAllNoShowPolicies(filters = {}) {
        const {
            isActive,
            isDefault,
            status,
            page  = 1,
            limit = 10
        } = filters;

        let whereClause = { type: 'no_show' };

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
                    model: noShowPolicyConfig,
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
     * Update No-Show Policy.
     */
    async updateNoShowPolicy(policyId, updateData, updatedBy) {
        const policyData = await policy.findByPk(policyId);

        if (!policyData) {
            throw new NotFoundError("No-show policy not found");
        }

        if (policyData.type !== 'no_show') {
            throw new ValidationError("This policy is not a no-show policy");
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
                        type: 'no_show',
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
            const existingConfig = await noShowPolicyConfig.findOne({ where: { policyId } });
            if (existingConfig) {
                await existingConfig.update(configData);
            } else {
                await noShowPolicyConfig.create({ policyId, ...configData });
            }
        }

        return await this.getNoShowPolicyById(policyId);
    }

    /**
     * Get the currently-effective no-show policy.
     */
    async getActiveNoShowPolicy() {
        const policyData = await policy.findOne({
            where: this._nowWhere(),
            include: [
                {
                    model: noShowPolicyConfig,
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
            throw new NotFoundError("No active no-show policy found");
        }

        return policyData;
    }

    /**
     * Delete No-Show Policy.
     */
    async deleteNoShowPolicy(policyId) {
        const policyData = await policy.findByPk(policyId);

        if (!policyData) {
            throw new NotFoundError("No-show policy not found");
        }

        if (policyData.type !== 'no_show') {
            throw new ValidationError("This policy is not a no-show policy");
        }

        if (policyData.isDefault) {
            throw new ConflictError("Cannot delete default no-show policy. Please set another policy as default first.");
        }

        await policyData.destroy();

        return { message: "No-show policy deleted successfully", policyId };
    }

    /**
     * Set Default No-Show Policy.
     */
    async setDefaultNoShowPolicy(policyId, updatedBy) {
        const policyData = await policy.findByPk(policyId);

        if (!policyData) {
            throw new NotFoundError("No-show policy not found");
        }

        if (policyData.type !== 'no_show') {
            throw new ValidationError("This policy is not a no-show policy");
        }

        if (!policyData.isActive) {
            throw new ValidationError("Cannot set inactive policy as default");
        }

        await policy.update(
            { isDefault: false },
            {
                where: {
                    type: 'no_show',
                    isDefault: true,
                    id: { [Op.ne]: policyId }
                }
            }
        );

        await policyData.update({ isDefault: true, updatedBy });

        return await this.getNoShowPolicyById(policyId);
    }

    /**
     * Toggle No-Show Policy Status.
     */
    async toggleNoShowPolicyStatus(policyId, updatedBy) {
        const policyData = await policy.findByPk(policyId);

        if (!policyData) {
            throw new NotFoundError("No-show policy not found");
        }

        if (policyData.type !== 'no_show') {
            throw new ValidationError("This policy is not a no-show policy");
        }

        if (policyData.isDefault && policyData.isActive) {
            const alternative = await policy.findOne({
                where: {
                    type: 'no_show',
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

        return await this.getNoShowPolicyById(policyId);
    }

    /**
     * Get No-Show Policy Statistics.
     */
    async getNoShowPolicyStatistics() {
        const totalPolicies  = await policy.count({ where: { type: 'no_show' } });
        const activePolicies = await policy.count({ where: { type: 'no_show', isActive: true } });

        const defaultPolicy = await policy.findOne({
            where: this._nowWhere(),
            order: [['isDefault', 'DESC'], ['effectiveFrom', 'DESC']],
            attributes: ['id', 'name', 'isActive', 'isDefault', 'effectiveFrom', 'effectiveTo']
        });

        return {
            totalNoShowPolicies:    totalPolicies,
            activeNoShowPolicies:   activePolicies,
            inactiveNoShowPolicies: totalPolicies - activePolicies,
            defaultNoShowPolicy:    defaultPolicy
        };
    }
}

module.exports = new NoShowPolicyService();

const { policy, reschedulePolicyConfig } = require('../../models');
const { NotFoundError, ConflictError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { Op } = require('sequelize');

/**
 * Reschedule Policy Management Service
 * Handles reschedule policies with effectiveFrom / effectiveTo scheduling.
 * Every policy is scoped to a zone (zoneId).
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

    async _checkOverlap(effectiveFrom, effectiveTo, zoneId, excludeId = null) {
        if (!effectiveFrom && !effectiveTo) return;

        const overlapping = await policy.findAll({
            where: {
                type: 'reschedule',
                isActive: true,
                zoneId: zoneId,
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
            throw new ConflictError("Policy date range overlaps with an active reschedule policy for this zone.");
        }
    }

    /**
     * Where-clause for "currently effective" policies, scoped to a zone.
     * @param {number|null} zoneId
     */
    _nowWhere(zoneId = null) {
        const now = new Date();
        return {
            type: 'reschedule',
            isActive: true,
            ...(zoneId !== null ? { zoneId } : {}),
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
            zoneId,
            ...configData
        } = data;

        if (!name) {
            throw new ValidationError("Policy name is required");
        }

        if (!zoneId) {
            throw new ValidationError("zoneId is required — every policy must belong to a zone");
        }

        this._validateDateRange(effectiveFrom, effectiveTo);

        if (isActive !== false) {
            await this._checkOverlap(effectiveFrom, effectiveTo, zoneId);
        }

        if (isDefault) {
            await policy.update(
                { isDefault: false },
                { where: { type: 'reschedule', isDefault: true, zoneId } }
            );
        }

        const newPolicy = await policy.create({
            name,
            type: 'reschedule',
            description,
            isActive:      isActive ?? true,
            isDefault:     isDefault ?? false,
            zoneId,
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
     * Pass `zoneId` to scope results to a specific zone.
     */
    async getAllReschedulePolicies(filters = {}) {
        const {
            isActive,
            isDefault,
            status,
            zoneId,
            page  = 1,
            limit = 10
        } = filters;

        let whereClause = { type: 'reschedule' };
        if (zoneId !== undefined) whereClause.zoneId = zoneId;

        if (status === 'active_now') {
            whereClause = this._nowWhere(zoneId ?? null);
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
            await this._checkOverlap(finalFrom, finalTo, policyData.zoneId, policyId);
        }

        if (isDefault) {
            await policy.update(
                { isDefault: false },
                {
                    where: {
                        type: 'reschedule',
                        isDefault: true,
                        zoneId: policyData.zoneId,
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
     * Get the currently-effective reschedule policy for a specific zone.
     * @param {number} zoneId
     */
    async getActiveReschedulePolicy(zoneId) {
        const policyData = await policy.findOne({
            where: this._nowWhere(zoneId),
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
            throw new NotFoundError("No active reschedule policy found for this zone");
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
     * Set Default Reschedule Policy (scoped to the same zone).
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
                    zoneId: policyData.zoneId,
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
                    zoneId: policyData.zoneId,
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
     * @param {number|null} zoneId - optional; pass to scope stats to one zone
     */
    async getReschedulePolicyStatistics(zoneId = null) {
        const zoneFilter = zoneId !== null ? { zoneId } : {};

        const totalPolicies  = await policy.count({ where: { type: 'reschedule', ...zoneFilter } });
        const activePolicies = await policy.count({ where: { type: 'reschedule', isActive: true, ...zoneFilter } });

        const defaultPolicy = await policy.findOne({
            where: this._nowWhere(zoneId),
            order: [['isDefault', 'DESC'], ['effectiveFrom', 'DESC']],
            attributes: ['id', 'name', 'isActive', 'isDefault', 'effectiveFrom', 'effectiveTo', 'zoneId']
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

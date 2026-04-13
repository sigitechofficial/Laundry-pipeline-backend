const { policy, cancellationPolicyConfig, zone } = require('../../models');
const { NotFoundError, ConflictError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { Op } = require('sequelize');

/**
 * Cancellation Policy Management Service
 * Handles cancellation policies with effectiveFrom / effectiveTo scheduling.
 *
 * Rules:
 *  - effectiveFrom: date policy starts being applicable (null = from the beginning)
 *  - effectiveTo  : date policy stops being applicable (null = never expires)
 *  - isActive     : manual on/off switch (false = force-disabled regardless of dates)
 *  - isDefault    : tie-breaker when multiple policies are valid at the same moment
 */
class CancellationPolicyService {

    // ─── helpers ────────────────────────────────────────────────────────────────

    /**
     * Validate that effectiveFrom < effectiveTo when both are provided.
     */
    _validateDateRange(effectiveFrom, effectiveTo) {
        if (effectiveFrom && effectiveTo) {
            const from = new Date(effectiveFrom);
            const to   = new Date(effectiveTo);
            if (from >= to) {
                throw new ValidationError("effectiveFrom must be earlier than effectiveTo");
            }
        }
    }

    /**
     * Check that the given [effectiveFrom, effectiveTo] window does not overlap
     * with any other active cancellation policy (excluding `excludeId`).
     *
     * Two ranges [A,B] and [C,D] overlap when A < D && C < B.
     * NULL on either side is treated as ±Infinity.
     */
    async _checkOverlap(effectiveFrom, effectiveTo, zoneId, excludeId = null) {
        if (!effectiveFrom && !effectiveTo) {
            return;
        }

        const overlapping = await policy.findAll({
            where: {
                type: 'cancellation',
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
            throw new ConflictError("Policy date range overlaps with an active cancellation policy for this zone.");
        }
    }

    /**
     * Where-clause for "currently effective" policies, scoped to a zone.
     * @param {number|null} zoneId
     */
    _nowWhere(zoneId = null) {
        const now = new Date();
        return {
            type: 'cancellation',
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
     * Create Cancellation Policy with Configuration.
     * Accepts optional effectiveFrom / effectiveTo in `data`.
     */
    async createCancellationPolicy(data) {
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
                { where: { type: 'cancellation', isDefault: true, zoneId } }
            );
        }

        const policyIsActive = isActive ?? true;

        const newPolicy = await policy.create({
            name,
            type: 'cancellation',
            description,
            isActive: policyIsActive,
            isDefault: isDefault ?? false,
            zoneId,
            effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null,
            effectiveTo:   effectiveTo   ? new Date(effectiveTo)   : null,
            createdBy
        });

        // Create config with matching isActive status
        await cancellationPolicyConfig.create({
            policyId: newPolicy.id,
            isActive: policyIsActive,
            ...configData
        });

        return await this.getCancellationPolicyById(newPolicy.id);
    }

    /**
     * Get Cancellation Policy by ID with Configuration.
     */
    async getCancellationPolicyById(policyId) {
        const policyData = await policy.findByPk(policyId, {
            include: [
                {
                    model: cancellationPolicyConfig,
                    as: 'cancellationConfig',
                    required: false
                },
                {
                    model: zone,
                    as: 'zone',
                    attributes: ['id', 'name'],
                    required: false
                }
            ]
        });

        if (!policyData) {
            throw new NotFoundError("Cancellation policy not found");
        }

        if (policyData.type !== 'cancellation') {
            throw new ValidationError("This policy is not a cancellation policy");
        }

        return policyData;
    }

    /**
     * Get All Cancellation Policies with Filters.
     * Adds `status` filter: 'active_now' returns only currently-effective policies.
     * Pass `zoneId` to scope results to a specific zone.
     */
    async getAllCancellationPolicies(filters = {}) {
        const {
            isActive,
            isDefault,
            status,
            zoneId,
            page  = 1,
            limit = 10
        } = filters;

        let whereClause = { type: 'cancellation' };
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
                    model: cancellationPolicyConfig,
                    as: 'cancellationConfig',
                    required: false
                },
                {
                    model: zone,
                    as: 'zone',
                    attributes: ['id', 'name'],
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
     * Update Cancellation Policy.
     * ONLY allows updating isActive status. All other fields are read-only.
     * When isActive is changed, it cascades to the policy config.
     */
    async updateCancellationPolicy(policyId, updateData, updatedBy) {
        const policyData = await policy.findByPk(policyId);

        if (!policyData) {
            throw new NotFoundError("Cancellation policy not found");
        }

        if (policyData.type !== 'cancellation') {
            throw new ValidationError("This policy is not a cancellation policy");
        }

        const { isActive } = updateData;

        // Only allow updating isActive status
        if (isActive === undefined) {
            throw new ValidationError("Only isActive status can be updated. To create a new policy configuration, please create a new policy.");
        }

        // Prevent editing other fields
        const restrictedFields = ['name', 'description', 'effectiveFrom', 'effectiveTo', 'isDefault', 'zoneId'];
        const attemptedRestrictedFields = restrictedFields.filter(field => updateData[field] !== undefined);
        if (attemptedRestrictedFields.length > 0) {
            throw new ValidationError(`Cannot update fields: ${attemptedRestrictedFields.join(', ')}. Only isActive status can be changed.`);
        }

        // If activating the policy, check for overlapping active policies in the same zone
        if (isActive && !policyData.isActive) {
            await this._checkOverlap(policyData.effectiveFrom, policyData.effectiveTo, policyData.zoneId, policyId);
        }

        // If deactivating the default policy, try to promote another active policy
        if (!isActive && policyData.isDefault && policyData.isActive) {
            const alternative = await policy.findOne({
                where: {
                    type: 'cancellation',
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

        // Update policy status
        await policyData.update({ 
            isActive: isActive,
            updatedBy 
        });

        // Cascade isActive status to the policy config
        const existingConfig = await cancellationPolicyConfig.findOne({ where: { policyId } });
        if (existingConfig) {
            await existingConfig.update({ isActive: isActive });
        }

        return await this.getCancellationPolicyById(policyId);
    }

    /**
     * Get the currently-effective cancellation policy for a specific zone.
     * Prefers isDefault = true; falls back to latest effectiveFrom then createdAt.
     * @param {number} zoneId
     */
    async getActiveCancellationPolicy(zoneId) {
        const policyData = await policy.findOne({
            where: this._nowWhere(zoneId),
            include: [
                {
                    model: cancellationPolicyConfig,
                    as: 'cancellationConfig',
                    required: false
                },
                {
                    model: zone,
                    as: 'zone',
                    attributes: ['id', 'name'],
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
            throw new NotFoundError("No active cancellation policy found for this zone");
        }

        return policyData;
    }

    /**
     * Delete Cancellation Policy.
     */
    async deleteCancellationPolicy(policyId) {
        const policyData = await policy.findByPk(policyId);

        if (!policyData) {
            throw new NotFoundError("Cancellation policy not found");
        }

        if (policyData.type !== 'cancellation') {
            throw new ValidationError("This policy is not a cancellation policy");
        }

        if (policyData.isDefault) {
            throw new ConflictError("Cannot delete default cancellation policy. Please set another policy as default first.");
        }

        await policyData.destroy();

        return { message: "Cancellation policy deleted successfully", policyId };
    }

    /**
     * Set Default Cancellation Policy.
     * The policy must be active to be set as default.
     * Also ensures the config is active when setting as default.
     */
    async setDefaultCancellationPolicy(policyId, updatedBy) {
        const policyData = await policy.findByPk(policyId);

        if (!policyData) {
            throw new NotFoundError("Cancellation policy not found");
        }

        if (policyData.type !== 'cancellation') {
            throw new ValidationError("This policy is not a cancellation policy");
        }

        if (!policyData.isActive) {
            throw new ValidationError("Cannot set inactive policy as default");
        }

        // Unset other defaults within the same zone
        await policy.update(
            { isDefault: false },
            {
                where: {
                    type: 'cancellation',
                    isDefault: true,
                    zoneId: policyData.zoneId,
                    id: { [Op.ne]: policyId }
                }
            }
        );

        await policyData.update({ isDefault: true, updatedBy });

        // Ensure config is also active
        const existingConfig = await cancellationPolicyConfig.findOne({ where: { policyId } });
        if (existingConfig && !existingConfig.isActive) {
            await existingConfig.update({ isActive: true });
        }

        return await this.getCancellationPolicyById(policyId);
    }

    /**
     * Toggle Cancellation Policy Active Status.
     * Also cascades the status change to the policy config.
     */
    async toggleCancellationPolicyStatus(policyId, updatedBy) {
        const policyData = await policy.findByPk(policyId);

        if (!policyData) {
            throw new NotFoundError("Cancellation policy not found");
        }

        if (policyData.type !== 'cancellation') {
            throw new ValidationError("This policy is not a cancellation policy");
        }

        const newStatus = !policyData.isActive;

        // If activating, check for overlapping active policies
        if (newStatus) {
            await this._checkOverlap(policyData.effectiveFrom, policyData.effectiveTo, policyData.zoneId, policyId);
        }

        // If deactivating the default, try to promote another active policy in the same zone
        if (policyData.isDefault && policyData.isActive) {
            const alternative = await policy.findOne({
                where: {
                    type: 'cancellation',
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

        // Update policy status
        await policyData.update({ isActive: newStatus, updatedBy });

        // Cascade isActive status to the policy config
        const existingConfig = await cancellationPolicyConfig.findOne({ where: { policyId } });
        if (existingConfig) {
            await existingConfig.update({ isActive: newStatus });
        }

        return await this.getCancellationPolicyById(policyId);
    }

    /**
     * Duplicate Cancellation Policy (dates are NOT copied – admin sets new window).
     * The duplicate stays in the same zone as the original.
     */
    async duplicateCancellationPolicy(policyId, newName, createdBy) {
        const originalPolicy = await this.getCancellationPolicyById(policyId);

        const configData = originalPolicy.cancellationConfig?.toJSON() || {};

        const duplicateData = {
            name: newName,
            description: originalPolicy.description,
            isActive: true,
            isDefault: false,
            zoneId: originalPolicy.zoneId,
            effectiveFrom: null,
            effectiveTo: null,
            createdBy,
            ...configData
        };

        delete duplicateData.id;
        delete duplicateData.policyId;
        delete duplicateData.createdAt;
        delete duplicateData.updatedAt;
        delete duplicateData.deletedAt;

        return await this.createCancellationPolicy(duplicateData);
    }

    /**
     * Get Cancellation Policy Statistics.
     * @param {number|null} zoneId - optional; pass to scope stats to one zone
     */
    async getCancellationPolicyStatistics(zoneId = null) {
        const zoneFilter = zoneId !== null ? { zoneId } : {};

        const totalPolicies  = await policy.count({ where: { type: 'cancellation', ...zoneFilter } });
        const activePolicies = await policy.count({ where: { type: 'cancellation', isActive: true, ...zoneFilter } });

        const defaultPolicy = await policy.findOne({
            where: this._nowWhere(zoneId),
            order: [['isDefault', 'DESC'], ['effectiveFrom', 'DESC']],
            attributes: ['id', 'name', 'isActive', 'isDefault', 'effectiveFrom', 'effectiveTo', 'zoneId']
        });

        return {
            totalCancellationPolicies:    totalPolicies,
            activeCancellationPolicies:   activePolicies,
            inactiveCancellationPolicies: totalPolicies - activePolicies,
            defaultCancellationPolicy:    defaultPolicy
        };
    }
}

module.exports = new CancellationPolicyService();

const { policy, cancellationPolicyConfig } = require('../../models');
const { NotFoundError, ConflictError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { Op } = require('sequelize');

/**
 * Cancellation Policy Management Service
 * Handles cancellation policies with configuration
 */
class CancellationPolicyService {
    
    /**
     * Create Cancellation Policy with Configuration
     * @param {Object} data - Policy data
     * @returns {Object} Created policy with configuration
     */
    async createCancellationPolicy(data) {
        const { name, description, createdBy, ...configData } = data;

        if (!name) {
            throw new ValidationError("Policy name is required");
        }

        // If setting as default, unset other default cancellation policies
        if (data.isDefault) {
            await policy.update(
                { isDefault: false },
                { where: { type: 'cancellation', isDefault: true } }
            );
        }

        const newPolicy = await policy.create({
            name,
            type: 'cancellation',
            description,
            isActive: data.isActive ?? true,
            isDefault: data.isDefault ?? false,
            createdBy
        });

        // Create cancellation configuration
        const config = await cancellationPolicyConfig.create({
            policyId: newPolicy.id,
            ...configData
        });

        return await this.getCancellationPolicyById(newPolicy.id);
    }

    /**
     * Get Cancellation Policy by ID with Configuration
     * @param {number} policyId - Policy ID
     * @returns {Object} Policy with configuration
     */
    async getCancellationPolicyById(policyId) {
        const policyData = await policy.findByPk(policyId, {
            include: [
                {
                    model: cancellationPolicyConfig,
                    as: 'cancellationConfig',
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
     * Get All Cancellation Policies with Filters
     * @param {Object} filters - Filter options
     * @returns {Object} Policies with pagination
     */
    async getAllCancellationPolicies(filters = {}) {
        const {
            isActive,
            isDefault,
            page = 1,
            limit = 10
        } = filters;

        const whereClause = { type: 'cancellation' };
        
        if (isActive !== undefined) whereClause.isActive = isActive;
        if (isDefault !== undefined) whereClause.isDefault = isDefault;

        const offset = (page - 1) * limit;

        const { count, rows } = await policy.findAndCountAll({
            where: whereClause,
            include: [
                {
                    model: cancellationPolicyConfig,
                    as: 'cancellationConfig',
                    required: false
                }
            ],
            order: [['createdAt', 'DESC']],
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

        return {
            policies: rows,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(count / limit)
            }
        };
    }

    /**
     * Update Cancellation Policy
     * @param {number} policyId - Policy ID
     * @param {Object} updateData - Update data
     * @param {number} updatedBy - Updated by user ID
     * @returns {Object} Updated policy
     */
    async updateCancellationPolicy(policyId, updateData, updatedBy) {
        const policyData = await policy.findByPk(policyId);
        
        if (!policyData) {
            throw new NotFoundError("Cancellation policy not found");
        }

        if (policyData.type !== 'cancellation') {
            throw new ValidationError("This policy is not a cancellation policy");
        }

        // If setting as default, unset other default cancellation policies
        if (updateData.isDefault) {
            await policy.update(
                { isDefault: false },
                { 
                    where: { 
                        type: 'cancellation', 
                        isDefault: true, 
                        id: { [Op.ne]: policyId } 
                    } 
                }
            );
        }

        // Separate policy data from config data
        const { 
            name, 
            description, 
            isActive, 
            isDefault, 
            ...configData 
        } = updateData;
        
        // Update policy
        const policyUpdateData = {};
        if (name !== undefined) policyUpdateData.name = name;
        if (description !== undefined) policyUpdateData.description = description;
        if (isActive !== undefined) policyUpdateData.isActive = isActive;
        if (isDefault !== undefined) policyUpdateData.isDefault = isDefault;
        
        if (Object.keys(policyUpdateData).length > 0) {
            policyUpdateData.updatedBy = updatedBy;
            await policyData.update(policyUpdateData);
        }

        // Update configuration
        if (Object.keys(configData).length > 0) {
            const existingConfig = await cancellationPolicyConfig.findOne({ 
                where: { policyId } 
            });
            
            if (existingConfig) {
                await existingConfig.update(configData);
            } else {
                await cancellationPolicyConfig.create({
                    policyId,
                    ...configData
                });
            }
        }

        return await this.getCancellationPolicyById(policyId);
    }

    /**
     * Get Active Cancellation Policy (Default or First Active)
     * @returns {Object} Active cancellation policy with configuration
     */
    async getActiveCancellationPolicy() {
        // First try to get default cancellation policy
        let policyData = await policy.findOne({
            where: { type: 'cancellation', isDefault: true, isActive: true },
            include: [
                {
                    model: cancellationPolicyConfig,
                    as: 'cancellationConfig',
                    required: false
                }
            ]
        });

        // If no default, get any active cancellation policy
        if (!policyData) {
            policyData = await policy.findOne({
                where: { type: 'cancellation', isActive: true },
                include: [
                    {
                        model: cancellationPolicyConfig,
                        as: 'cancellationConfig',
                        required: false
                    }
                ],
                order: [['createdAt', 'DESC']]
            });
        }

        if (!policyData) {
            throw new NotFoundError("No active cancellation policy found");
        }

        return policyData;
    }

    /**
     * Delete Cancellation Policy
     * @param {number} policyId - Policy ID
     * @returns {Object} Deletion result
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

        return {
            message: "Cancellation policy deleted successfully",
            policyId
        };
    }

    /**
     * Set Default Cancellation Policy
     * @param {number} policyId - Policy ID
     * @param {number} updatedBy - Updated by user ID
     * @returns {Object} Updated policy
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

        // Unset other default cancellation policies
        await policy.update(
            { isDefault: false },
            { 
                where: { 
                    type: 'cancellation', 
                    isDefault: true, 
                    id: { [Op.ne]: policyId } 
                } 
            }
        );

        // Set this policy as default
        await policyData.update({
            isDefault: true,
            updatedBy
        });

        return await this.getCancellationPolicyById(policyId);
    }

    /**
     * Toggle Cancellation Policy Status
     * @param {number} policyId - Policy ID
     * @param {number} updatedBy - Updated by user ID
     * @returns {Object} Updated policy
     */
    async toggleCancellationPolicyStatus(policyId, updatedBy) {
        const policyData = await policy.findByPk(policyId);
        
        if (!policyData) {
            throw new NotFoundError("Cancellation policy not found");
        }

        if (policyData.type !== 'cancellation') {
            throw new ValidationError("This policy is not a cancellation policy");
        }

        // If deactivating default policy, set another as default
        if (policyData.isDefault && policyData.isActive) {
            const alternativePolicy = await policy.findOne({
                where: { 
                    type: 'cancellation', 
                    isActive: true, 
                    isDefault: false, 
                    id: { [Op.ne]: policyId } 
                }
            });

            if (alternativePolicy) {
                await alternativePolicy.update({ isDefault: true });
            }
        }

        await policyData.update({
            isActive: !policyData.isActive,
            updatedBy
        });

        return await this.getCancellationPolicyById(policyId);
    }

    /**
     * Duplicate Cancellation Policy
     * @param {number} policyId - Policy ID
     * @param {string} newName - New policy name
     * @param {number} createdBy - Created by user ID
     * @returns {Object} Duplicated policy
     */
    async duplicateCancellationPolicy(policyId, newName, createdBy) {
        const originalPolicy = await this.getCancellationPolicyById(policyId);
        
        const configData = originalPolicy.cancellationConfig?.toJSON() || {};
        
        const duplicateData = {
            name: newName,
            description: originalPolicy.description,
            isActive: true,
            isDefault: false,
            createdBy,
            ...configData
        };

        // Remove fields that shouldn't be duplicated
        delete duplicateData.id;
        delete duplicateData.policyId;
        delete duplicateData.createdAt;
        delete duplicateData.updatedAt;
        delete duplicateData.deletedAt;

        return await this.createCancellationPolicy(duplicateData);
    }

    /**
     * Get Cancellation Policy Statistics
     * @returns {Object} Policy statistics
     */
    async getCancellationPolicyStatistics() {
        const totalPolicies = await policy.count({ 
            where: { type: 'cancellation' } 
        });
        
        const activePolicies = await policy.count({ 
            where: { type: 'cancellation', isActive: true } 
        });

        const defaultPolicy = await policy.findOne({
            where: { type: 'cancellation', isDefault: true, isActive: true },
            attributes: ['id', 'name', 'isActive']
        });

        return {
            totalCancellationPolicies: totalPolicies,
            activeCancellationPolicies: activePolicies,
            inactiveCancellationPolicies: totalPolicies - activePolicies,
            defaultCancellationPolicy: defaultPolicy
        };
    }
}

module.exports = new CancellationPolicyService();


const { policy, noShowPolicyConfig } = require('../../models');
const { NotFoundError, ConflictError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { Op } = require('sequelize');

/**
 * No-Show Policy Management Service
 * Handles no-show policies with configuration
 */
class NoShowPolicyService {
    
    /**
     * Create No-Show Policy with Configuration
     * @param {Object} data - Policy data
     * @returns {Object} Created policy with configuration
     */
    async createNoShowPolicy(data) {
        const { name, description, createdBy, ...configData } = data;

        if (!name) {
            throw new ValidationError("Policy name is required");
        }

        // If setting as default, unset other default no-show policies
        if (data.isDefault) {
            await policy.update(
                { isDefault: false },
                { where: { type: 'no_show', isDefault: true } }
            );
        }

        const newPolicy = await policy.create({
            name,
            type: 'no_show',
            description,
            isActive: data.isActive ?? true,
            isDefault: data.isDefault ?? false,
            createdBy
        });

        // Create no-show configuration
        const config = await noShowPolicyConfig.create({
            policyId: newPolicy.id,
            ...configData
        });

        return await this.getNoShowPolicyById(newPolicy.id);
    }

    /**
     * Get No-Show Policy by ID with Configuration
     * @param {number} policyId - Policy ID
     * @returns {Object} Policy with configuration
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
     * Get All No-Show Policies with Filters
     * @param {Object} filters - Filter options
     * @returns {Object} Policies with pagination
     */
    async getAllNoShowPolicies(filters = {}) {
        const {
            isActive,
            isDefault,
            page = 1,
            limit = 10
        } = filters;

        const whereClause = { type: 'no_show' };
        
        if (isActive !== undefined) whereClause.isActive = isActive;
        if (isDefault !== undefined) whereClause.isDefault = isDefault;

        const offset = (page - 1) * limit;

        const { count, rows } = await policy.findAndCountAll({
            where: whereClause,
            include: [
                {
                    model: noShowPolicyConfig,
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
     * Update No-Show Policy
     * @param {number} policyId - Policy ID
     * @param {Object} updateData - Update data
     * @param {number} updatedBy - Updated by user ID
     * @returns {Object} Updated policy
     */
    async updateNoShowPolicy(policyId, updateData, updatedBy) {
        const policyData = await policy.findByPk(policyId);
        
        if (!policyData) {
            throw new NotFoundError("No-show policy not found");
        }

        if (policyData.type !== 'no_show') {
            throw new ValidationError("This policy is not a no-show policy");
        }

        // If setting as default, unset other default no-show policies
        if (updateData.isDefault) {
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
            const existingConfig = await noShowPolicyConfig.findOne({ 
                where: { policyId } 
            });
            
            if (existingConfig) {
                await existingConfig.update(configData);
            } else {
                await noShowPolicyConfig.create({
                    policyId,
                    ...configData
                });
            }
        }

        return await this.getNoShowPolicyById(policyId);
    }

    /**
     * Get Active No-Show Policy (Default or First Active)
     * @returns {Object} Active no-show policy with configuration
     */
    async getActiveNoShowPolicy() {
        // First try to get default no-show policy
        let policyData = await policy.findOne({
            where: { type: 'no_show', isDefault: true, isActive: true },
            include: [
                {
                    model: noShowPolicyConfig,
                    required: false
                }
            ]
        });

        // If no default, get any active no-show policy
        if (!policyData) {
            policyData = await policy.findOne({
                where: { type: 'no_show', isActive: true },
                include: [
                    {
                        model: noShowPolicyConfig,
                        required: false
                    }
                ],
                order: [['createdAt', 'DESC']]
            });
        }

        if (!policyData) {
            throw new NotFoundError("No active no-show policy found");
        }

        return policyData;
    }

    /**
     * Delete No-Show Policy
     * @param {number} policyId - Policy ID
     * @returns {Object} Deletion result
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

        return {
            message: "No-show policy deleted successfully",
            policyId
        };
    }

    /**
     * Set Default No-Show Policy
     * @param {number} policyId - Policy ID
     * @param {number} updatedBy - Updated by user ID
     * @returns {Object} Updated policy
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

        // Unset other default no-show policies
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

        // Set this policy as default
        await policyData.update({
            isDefault: true,
            updatedBy
        });

        return await this.getNoShowPolicyById(policyId);
    }

    /**
     * Toggle No-Show Policy Status
     * @param {number} policyId - Policy ID
     * @param {number} updatedBy - Updated by user ID
     * @returns {Object} Updated policy
     */
    async toggleNoShowPolicyStatus(policyId, updatedBy) {
        const policyData = await policy.findByPk(policyId);
        
        if (!policyData) {
            throw new NotFoundError("No-show policy not found");
        }

        if (policyData.type !== 'no_show') {
            throw new ValidationError("This policy is not a no-show policy");
        }

        // If deactivating default policy, set another as default
        if (policyData.isDefault && policyData.isActive) {
            const alternativePolicy = await policy.findOne({
                where: { 
                    type: 'no_show', 
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

        return await this.getNoShowPolicyById(policyId);
    }

    /**
     * Get No-Show Policy Statistics
     * @returns {Object} Policy statistics
     */
    async getNoShowPolicyStatistics() {
        const totalPolicies = await policy.count({ 
            where: { type: 'no_show' } 
        });
        
        const activePolicies = await policy.count({ 
            where: { type: 'no_show', isActive: true } 
        });

        const defaultPolicy = await policy.findOne({
            where: { type: 'no_show', isDefault: true, isActive: true },
            attributes: ['id', 'name', 'isActive']
        });

        return {
            totalNoShowPolicies: totalPolicies,
            activeNoShowPolicies: activePolicies,
            inactiveNoShowPolicies: totalPolicies - activePolicies,
            defaultNoShowPolicy: defaultPolicy
        };
    }
}

module.exports = new NoShowPolicyService();


const { policy, reschedulePolicyConfig } = require('../../models');
const { NotFoundError, ConflictError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { Op } = require('sequelize');

/**
 * Reschedule Policy Management Service
 * Handles reschedule policies with configuration
 */
class ReschedulePolicyService {
    
    /**
     * Create Reschedule Policy with Configuration
     * @param {Object} data - Policy data
     * @returns {Object} Created policy with configuration
     */
    async createReschedulePolicy(data) {
        const { name, description, createdBy, ...configData } = data;

        if (!name) {
            throw new ValidationError("Policy name is required");
        }

        // If setting as default, unset other default reschedule policies
        if (data.isDefault) {
            await policy.update(
                { isDefault: false },
                { where: { type: 'reschedule', isDefault: true } }
            );
        }

        const newPolicy = await policy.create({
            name,
            type: 'reschedule',
            description,
            isActive: data.isActive ?? true,
            isDefault: data.isDefault ?? false,
            createdBy
        });

        // Create reschedule configuration
        const config = await reschedulePolicyConfig.create({
            policyId: newPolicy.id,
            ...configData
        });

        return await this.getReschedulePolicyById(newPolicy.id);
    }

    /**
     * Get Reschedule Policy by ID with Configuration
     * @param {number} policyId - Policy ID
     * @returns {Object} Policy with configuration
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
     * Get All Reschedule Policies with Filters
     * @param {Object} filters - Filter options
     * @returns {Object} Policies with pagination
     */
    async getAllReschedulePolicies(filters = {}) {
        const {
            isActive,
            isDefault,
            page = 1,
            limit = 10
        } = filters;

        const whereClause = { type: 'reschedule' };
        
        if (isActive !== undefined) whereClause.isActive = isActive;
        if (isDefault !== undefined) whereClause.isDefault = isDefault;

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
     * Update Reschedule Policy
     * @param {number} policyId - Policy ID
     * @param {Object} updateData - Update data
     * @param {number} updatedBy - Updated by user ID
     * @returns {Object} Updated policy
     */
    async updateReschedulePolicy(policyId, updateData, updatedBy) {
        const policyData = await policy.findByPk(policyId);
        
        if (!policyData) {
            throw new NotFoundError("Reschedule policy not found");
        }

        if (policyData.type !== 'reschedule') {
            throw new ValidationError("This policy is not a reschedule policy");
        }

        // If setting as default, unset other default reschedule policies
        if (updateData.isDefault) {
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
            const existingConfig = await reschedulePolicyConfig.findOne({ 
                where: { policyId } 
            });
            
            if (existingConfig) {
                await existingConfig.update(configData);
            } else {
                await reschedulePolicyConfig.create({
                    policyId,
                    ...configData
                });
            }
        }

        return await this.getReschedulePolicyById(policyId);
    }

    /**
     * Get Active Reschedule Policy (Default or First Active)
     * @returns {Object} Active reschedule policy with configuration
     */
    async getActiveReschedulePolicy() {
        // First try to get default reschedule policy
        let policyData = await policy.findOne({
            where: { type: 'reschedule', isDefault: true, isActive: true },
            include: [
                {
                    model: reschedulePolicyConfig,
                    as: 'rescheduleConfig',
                    required: false
                }
            ]
        });

        // If no default, get any active reschedule policy
        if (!policyData) {
            policyData = await policy.findOne({
                where: { type: 'reschedule', isActive: true },
                include: [
                    {
                        model: reschedulePolicyConfig,
                        as: 'rescheduleConfig',
                        required: false
                    }
                ],
                order: [['createdAt', 'DESC']]
            });
        }

        if (!policyData) {
            throw new NotFoundError("No active reschedule policy found");
        }

        return policyData;
    }

    /**
     * Delete Reschedule Policy
     * @param {number} policyId - Policy ID
     * @returns {Object} Deletion result
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

        return {
            message: "Reschedule policy deleted successfully",
            policyId
        };
    }

    /**
     * Set Default Reschedule Policy
     * @param {number} policyId - Policy ID
     * @param {number} updatedBy - Updated by user ID
     * @returns {Object} Updated policy
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

        // Unset other default reschedule policies
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

        // Set this policy as default
        await policyData.update({
            isDefault: true,
            updatedBy
        });

        return await this.getReschedulePolicyById(policyId);
    }

    /**
     * Toggle Reschedule Policy Status
     * @param {number} policyId - Policy ID
     * @param {number} updatedBy - Updated by user ID
     * @returns {Object} Updated policy
     */
    async toggleReschedulePolicyStatus(policyId, updatedBy) {
        const policyData = await policy.findByPk(policyId);
        
        if (!policyData) {
            throw new NotFoundError("Reschedule policy not found");
        }

        if (policyData.type !== 'reschedule') {
            throw new ValidationError("This policy is not a reschedule policy");
        }

        // If deactivating default policy, set another as default
        if (policyData.isDefault && policyData.isActive) {
            const alternativePolicy = await policy.findOne({
                where: { 
                    type: 'reschedule', 
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

        return await this.getReschedulePolicyById(policyId);
    }

    /**
     * Get Reschedule Policy Statistics
     * @returns {Object} Policy statistics
     */
    async getReschedulePolicyStatistics() {
        const totalPolicies = await policy.count({ 
            where: { type: 'reschedule' } 
        });
        
        const activePolicies = await policy.count({ 
            where: { type: 'reschedule', isActive: true } 
        });

        const defaultPolicy = await policy.findOne({
            where: { type: 'reschedule', isDefault: true, isActive: true },
            attributes: ['id', 'name', 'isActive']
        });

        return {
            totalReschedulePolicies: totalPolicies,
            activeReschedulePolicies: activePolicies,
            inactiveReschedulePolicies: totalPolicies - activePolicies,
            defaultReschedulePolicy: defaultPolicy
        };
    }
}

module.exports = new ReschedulePolicyService();


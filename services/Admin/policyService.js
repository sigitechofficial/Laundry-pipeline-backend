const { policy, noShowPolicyConfig } = require('../../models');
const { NotFoundError, ConflictError, ValidationError } = require('../../middlewares/universalErrorHandler');

/**
 * policy Management Service - 2 Table Approach
 * Main policy table + Configuration table
 */
class policyService {
    
    /**
     * Create policy with Configuration
     * @param {Object} data - policy data
     * @returns {Object} Created policy with configuration
     */
    async createpolicy(data) {
        const { name, type, description, createdBy, ...configData } = data;

        if (!name) {
            throw new ValidationError("policy name is required");
        }

        if (!type) {
            throw new ValidationError("policy type is required");
        }

        // If setting as default, unset other default policies of same type
        if (data.isDefault) {
            await policy.update(
                { isDefault: false },
                { where: { type, isDefault: true } }
            );
        }

        const policy = await policy.create({
            name,
            type,
            description,
            isActive: data.isActive ?? true,
            isDefault: data.isDefault ?? false,
            createdBy
        });

        // Create configuration
        const config = await noShowPolicyConfig.create({
            policyId: policy.id,
            ...configData
        });

        return await this.getPolicyById(policy.id);
    }

    /**
     * Get policy by ID with Configuration
     * @param {number} policyId - policy ID
     * @returns {Object} policy with configuration
     */
    async getPolicyById(policyId) {
        const policy = await policy.findByPk(policyId, {
            include: [
                {
                    model: noShowPolicyConfig,
                    as: 'noShowConfig',
                    required: false
                }
            ]
        });

        if (!policy) {
            throw new NotFoundError("policy not found");
        }

        return policy;
    }

    /**
     * Get All Policies with Filters
     * @param {Object} filters - Filter options
     * @returns {Object} Policies with pagination
     */
    async getAllPolicies(filters = {}) {
        const {
            type,
            isActive,
            isDefault,
            page = 1,
            limit = 10
        } = filters;

        const whereClause = {};
        
        if (type) whereClause.type = type;
        if (isActive !== undefined) whereClause.isActive = isActive;
        if (isDefault !== undefined) whereClause.isDefault = isDefault;

        const offset = (page - 1) * limit;

        const { count, rows } = await policy.findAndCountAll({
            where: whereClause,
            include: [
                {
                    model: noShowPolicyConfig,
                    as: 'noShowConfig',
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
     * Update policy
     * @param {number} policyId - policy ID
     * @param {Object} updateData - Update data
     * @param {number} updatedBy - Updated by user ID
     * @returns {Object} Updated policy
     */
    async updatepolicy(policyId, updateData, updatedBy) {
        const policy = await policy.findByPk(policyId);
        
        if (!policy) {
            throw new NotFoundError("policy not found");
        }

        // If setting as default, unset other default policies of same type
        if (updateData.isDefault) {
            await policy.update(
                { isDefault: false },
                { where: { type: policy.type, isDefault: true, id: { [require('sequelize').Op.ne]: policyId } } }
            );
        }

        // Separate policy data from config data
        const { config, ...policyData } = updateData;
        
        // Update policy
        if (Object.keys(policyData).length > 0) {
            await policy.update({
                ...policyData,
                updatedBy
            });
        }

        // Update configuration
        if (config && Object.keys(config).length > 0) {
            const existingConfig = await noShowPolicyConfig.findOne({ where: { policyId } });
            
            if (existingConfig) {
                await existingConfig.update(config);
            } else {
                await noShowPolicyConfig.create({
                    policyId,
                    ...config
                });
            }
        }

        return await this.getPolicyById(policyId);
    }

    /**
     * Get policy by Type with Default Fallback
     * @param {string} type - policy type
     * @returns {Object} policy with configuration
     */
    async getpolicyByType(type) {
        // First try to get default policy of this type
        let policy = await policy.findOne({
            where: { type, isDefault: true, isActive: true },
            include: [
                {
                    model: noShowPolicyConfig,
                    as: 'noShowConfig',
                    required: false
                }
            ]
        });

        // If no default, get any active policy of this type
        if (!policy) {
            policy = await policy.findOne({
                where: { type, isActive: true },
                include: [
                    {
                        model: noShowPolicyConfig,
                        as: 'noShowConfig',
                        required: false
                    }
                ],
                order: [['createdAt', 'DESC']]
            });
        }

        if (!policy) {
            throw new NotFoundError(`No active policy found for type: ${type}`);
        }

        return policy;
    }

    /**
     * Get policy Statistics
     * @returns {Object} policy statistics
     */
    async getpolicyStatistics() {
        const totalPolicies = await policy.count();
        const activePolicies = await policy.count({ where: { isActive: true } });
        
        const policiesByType = await policy.findAll({
            attributes: [
                'type',
                [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']
            ],
            where: { isActive: true },
            group: ['type']
        });

        const defaultPolicies = await policy.findAll({
            where: { isDefault: true, isActive: true },
            attributes: ['id', 'name', 'type']
        });

        return {
            totalPolicies,
            activePolicies,
            inactivePolicies: totalPolicies - activePolicies,
            policiesByType,
            defaultPolicies
        };
    }

    /**
     * Delete policy
     * @param {number} policyId - policy ID
     * @returns {Object} Deletion result
     */
    async deletepolicy(policyId) {
        const policy = await policy.findByPk(policyId);
        
        if (!policy) {
            throw new NotFoundError("policy not found");
        }

        if (policy.isDefault) {
            throw new ConflictError("Cannot delete default policy. Please set another policy as default first.");
        }

        await policy.destroy();

        return {
            message: "policy deleted successfully",
            policyId
        };
    }

    /**
     * Set Default policy
     * @param {number} policyId - policy ID
     * @param {number} updatedBy - Updated by user ID
     * @returns {Object} Updated policy
     */
    async setDefaultpolicy(policyId, updatedBy) {
        const policy = await policy.findByPk(policyId);
        
        if (!policy) {
            throw new NotFoundError("policy not found");
        }

        if (!policy.isActive) {
            throw new ValidationError("Cannot set inactive policy as default");
        }

        // Unset other default policies of same type
        await policy.update(
            { isDefault: false },
            { where: { type: policy.type, isDefault: true, id: { [require('sequelize').Op.ne]: policyId } } }
        );

        // Set this policy as default
        await policy.update({
            isDefault: true,
            updatedBy
        });

        return await this.getPolicyById(policyId);
    }

    /**
     * Toggle policy Status
     * @param {number} policyId - policy ID
     * @param {number} updatedBy - Updated by user ID
     * @returns {Object} Updated policy
     */
    async togglepolicyStatus(policyId, updatedBy) {
        const policy = await policy.findByPk(policyId);
        
        if (!policy) {
            throw new NotFoundError("policy not found");
        }

        // If deactivating default policy, set another as default
        if (policy.isDefault && policy.isActive) {
            const alternativepolicy = await policy.findOne({
                where: { type: policy.type, isActive: true, isDefault: false, id: { [require('sequelize').Op.ne]: policyId } }
            });

            if (alternativepolicy) {
                await alternativepolicy.update({ isDefault: true });
            }
        }

        await policy.update({
            isActive: !policy.isActive,
            updatedBy
        });

        return await this.getPolicyById(policyId);
    }

    /**
     * Duplicate policy
     * @param {number} policyId - policy ID
     * @param {string} newName - New policy name
     * @param {number} createdBy - Created by user ID
     * @returns {Object} Duplicated policy
     */
    async duplicatepolicy(policyId, newName, createdBy) {
        const originalpolicy = await this.getPolicyById(policyId);
        
        const duplicateData = {
            name: newName,
            type: originalpolicy.type,
            description: originalpolicy.description,
            isActive: true,
            isDefault: false,
            createdBy,
            ...originalpolicy.config?.toJSON()
        };

        // Remove fields that shouldn't be duplicated
        delete duplicateData.id;
        delete duplicateData.createdAt;
        delete duplicateData.updatedAt;
        delete duplicateData.deletedAt;

        return await this.createpolicy(duplicateData);
    }
}

module.exports = new policyService();

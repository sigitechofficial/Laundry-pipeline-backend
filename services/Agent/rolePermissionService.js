require("dotenv").config();
const { 
    roles, 
    permissions, 
    features, 
    classifiedAs 
} = require('../../models');
const { Op } = require('sequelize');
const { 
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError 
} = require('../../middlewares/universalErrorHandler');

/**
 * Agent Role & Permission Service
 * Handles all agent role and permission related business logic
 */
class AgentRolePermissionService {

    /**
     * Add Role
     * @param {Object} data - Role data
     * @param {string} data.name - Role name
     * @param {Array} data.permissionRole - Permission role array
     * @returns {Object} Role creation result
     */
    async addRole(data) {
        const { name, permissionRole } = data;

        const checkExist = await roles.findOne({ where: { name } });
        if (checkExist) {
            throw new ConflictError("Same role exists Please try another name", { 
            });
        }

        const newRole = await roles.create({ name, status: true });

        let bulkArray = permissionRole.map((ele) => ({
            featureId: ele.id,
            roleId: newRole.id,
            read: ele.permissions.read || false,
            write: ele.permissions.write || false
        }));

        await permissions.bulkCreate(bulkArray);

        return {
            newRole,
        };
    }

    /**
     * Update Roles
     * @param {Object} data - Role update data
     * @param {string} data.name - Role name
     * @param {Array} data.permissionRole - Permission role array
     * @param {number} data.roleId - Role ID
     * @returns {Object} Role update result
     */
    async updateRoles(data) {
        const { name, permissionRole, roleId } = data;

        if (!roleId) {
            throw new ValidationError("Missing role ID", { 
                message: "Role ID is required to update role" 
            });
        }

        if (name) {
            const checkExist = await roles.findOne({
                where: { name, id: { [Op.not]: roleId } },
            });

            if (checkExist) {
                throw new ConflictError("Same role exists Please try another name");
            }
        }

        const updatePayload = {};
        if (name) updatePayload.name = name;
        updatePayload.status = true;

        await roles.update(updatePayload, { where: { id: roleId } });

        if (Array.isArray(permissionRole) && permissionRole.length > 0) {
            await permissions.destroy({ where: { roleId } });

            let bulkArray = permissionRole.map((ele) => ({
                featureId: ele.id,
                roleId: roleId,
                read: ele.permissions.read || false,
                write: ele.permissions.write || false
            }));

            await permissions.bulkCreate(bulkArray);
        }

        return {
        };
    }

    /**
     * Get All Roles
     * @returns {Object} All roles data
     */
    async getAllRoles() {
        const getRoles = await roles.findAll({
            where: {
                status: true,
            },
            attributes: ["id", "name", "status"],
        });

        return {
            getRoles,
        };
    }

    /**
     * Get Permissions
     * @param {Object} data - Permission data
     * @param {number} data.roleId - Role ID
     * @returns {Object} Permissions data
     */
    async getPermissions(data) {
        const { roleId } = data;

        const getPermissions = await permissions.findAll({
            where: {
                roleId: roleId
            },
            include: [
                {
                    model: features,
                    attributes: ['id', 'title', 'status']
                },
                {
                    model: roles,
                    attributes: ['id', 'name', 'status']
                },
            ],
            attributes: ['id', 'read', 'write', 'featureId', 'roleId']
        });

        return {
            getPermissions,
        };
    }

    /**
     * Add Classified As
     * @param {Object} data - Classified data
     * @param {string} data.name - Classified name
     * @returns {Object} Classified creation result
     */
    async addClassifiedAs(data) {
        const { name } = data;

        const createData = await classifiedAs.create({
            name,
        });

        return {
            createData,
        };
    }

    /**
     * Get Classified As
     * @returns {Object} All classified data
     */
    async getClassifiedAs() {
        const getClassifiedAs = await classifiedAs.findAll({
            attributes: ["id", "name", "status"],
        });

        return {
            getClassifiedAs,
        };
    }

    /**
     * Add Features
     * @param {Object} data - Feature data
     * @param {string} data.title - Feature title
     * @param {string} data.description - Feature description
     * @returns {Object} Feature creation result
     */
    async addfeatures(data) {
        const { title, description } = data;

        const createData = await features.create({
            title,
            description,
            status: true
        });

        return {
            createData,
        };
    }

    /**
     * Get Features
     * @returns {Object} All features data
     */
    async getFeatures() {
        const getFeatures = await features.findAll({
            where: {
                status: true,
            },
            attributes: ["id", "title", "description", "status"],
        });

        return {
            getFeatures,
        };
    }
}

module.exports = new AgentRolePermissionService();

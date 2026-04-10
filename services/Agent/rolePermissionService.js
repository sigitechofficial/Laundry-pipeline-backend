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

/** `featureOf` values used by the agent app (shop / employees). Not Admin-only. */
const AGENT_APP_FEATURE_OF = ['Agent', 'Agent Employee', 'both'];

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

        const bulkArray = permissionRole.map((ele) => ({
            featureId: ele.id,
            roleId: newRole.id,
            create: ele.permissions?.create === true || ele.permissions?.write === true,
            read:   ele.permissions?.read   === true,
            update: ele.permissions?.update === true || ele.permissions?.write === true,
            delete: ele.permissions?.delete === true || ele.permissions?.write === true,
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

            const bulkArray = permissionRole.map((ele) => ({
                featureId: ele.id,
                roleId: roleId,
                create: ele.permissions?.create === true || ele.permissions?.write === true,
                read:   ele.permissions?.read   === true,
                update: ele.permissions?.update === true || ele.permissions?.write === true,
                delete: ele.permissions?.delete === true || ele.permissions?.write === true,
            }));

            await permissions.bulkCreate(bulkArray);
        }

        return {
        };
    }

    /**
     * Roles for the agent app: tied to Agent / Agent Employee / both features only.
     * Excludes any role that has a permission on an Admin-only feature, or only admin-side permissions.
     * Roles with no permission rows yet are still listed (e.g. newly created).
     * @returns {Object} All roles data
     */
    async getAllRoles() {
        const [adminFeatureRows, agentFeatureRows, anyPermRows] = await Promise.all([
            permissions.findAll({
                attributes: ['roleId'],
                include: [
                    {
                        model: features,
                        required: true,
                        where: { featureOf: 'Admin' },
                        attributes: [],
                    },
                ],
                raw: true,
            }),
            permissions.findAll({
                attributes: ['roleId'],
                include: [
                    {
                        model: features,
                        required: true,
                        where: { featureOf: { [Op.in]: AGENT_APP_FEATURE_OF } },
                        attributes: [],
                    },
                ],
                raw: true,
            }),
            permissions.findAll({ attributes: ['roleId'], raw: true }),
        ]);

        const roleIdsWithAdminFeature = new Set(
            adminFeatureRows.map((r) => r.roleId).filter(Boolean)
        );
        const roleIdsWithAgentAppFeature = new Set(
            agentFeatureRows.map((r) => r.roleId).filter(Boolean)
        );
        const roleIdsWithAnyPermission = new Set(
            anyPermRows.map((r) => r.roleId).filter(Boolean)
        );

        const allActive = await roles.findAll({
            where: { status: true },
            attributes: ['id', 'name', 'status'],
        });

        const getRoles = allActive.filter((role) => {
            if (roleIdsWithAdminFeature.has(role.id)) {
                return false;
            }
            if (!roleIdsWithAnyPermission.has(role.id)) {
                return true;
            }
            return roleIdsWithAgentAppFeature.has(role.id);
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
            attributes: ['id', 'create', 'read', 'update', 'delete', 'featureId', 'roleId']
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

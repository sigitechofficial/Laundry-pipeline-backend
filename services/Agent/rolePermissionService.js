require("dotenv").config();
const { 
    roles, 
    permissions, 
    features, 
    classifiedAs 
} = require('../../models');
const { Op } = require('sequelize');
const { 
    ConflictError, 
    ValidationError 
} = require('../../middlewares/universalErrorHandler');
const {
    AGENT_SHOP_STAFF_ROLE_IDS,
    SYSTEM_ROLES,
    AGENT_APP_FEATURE_OF,
    isAgentShopStaffRoleId,
    isAdminPortalRoleId,
    isAdminPortalRoleName,
    isAgentShopRoleName,
    SYSTEM_ROLE_NAMES,
} = require('../../constants/systemRoles');

/**
 * Agent Role & Permission Service
 * Agent shop staff only — never surfaces or mutates Admin portal roles (Zone Admin).
 */
class AgentRolePermissionService {

    async addRole(data) {
        const { name, permissionRole } = data;

        if (isAgentShopRoleName(name)) {
            throw new ConflictError(
                'Laundry Shop Driver and Manager are system Agent employee roles'
            );
        }
        if (isAdminPortalRoleName(name)) {
            throw new ConflictError(
                'Zone Admin is an Admin employee system role and cannot be created from the agent app'
            );
        }

        const checkExist = await roles.findOne({ where: { name } });
        if (checkExist) {
            throw new ConflictError("Same role exists Please try another name", { 
            });
        }

        const newRole = await roles.create({ name, status: true });

        const bulkArray = (permissionRole || []).map((ele) => ({
            featureId: ele.id,
            roleId: newRole.id,
            create: ele.permissions?.create === true || ele.permissions?.write === true,
            read:   ele.permissions?.read   === true,
            update: ele.permissions?.update === true || ele.permissions?.write === true,
            delete: ele.permissions?.delete === true || ele.permissions?.write === true,
        }));

        if (bulkArray.length > 0) {
            await permissions.bulkCreate(bulkArray);
        }

        return {
            newRole,
        };
    }

    async updateRoles(data) {
        const { name, permissionRole, roleId } = data;

        if (!roleId) {
            throw new ValidationError("Missing role ID", { 
                message: "Role ID is required to update role" 
            });
        }

        if (isAgentShopStaffRoleId(roleId)) {
            throw new ValidationError(
                `${SYSTEM_ROLE_NAMES[Number(roleId)]} is a system Agent employee role and cannot be modified here`
            );
        }
        if (isAdminPortalRoleId(roleId)) {
            throw new ValidationError(
                'Zone Admin is an Admin employee system role and cannot be modified from the agent app'
            );
        }

        if (name) {
            if (isAgentShopRoleName(name) || isAdminPortalRoleName(name)) {
                throw new ConflictError('Cannot rename a role to a reserved system role name');
            }
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
     * Roles for the agent app team picker:
     * Only system shop staff — Driver (6) + Manager (8).
     * Never Zone Admin / Admin Employee roles / leftover custom admin-ish roles.
     */
    async getAllRoles() {
        const roleRows = await roles.findAll({
            where: {
                status: true,
                id: { [Op.in]: [...AGENT_SHOP_STAFF_ROLE_IDS] },
            },
            attributes: ['id', 'name', 'status'],
            order: [['id', 'ASC']],
        });

        return {
            getRoles: roleRows.filter((r) => !isAdminPortalRoleName(r.name)),
        };
    }

    async getPermissions(data) {
        const { roleId } = data;

        // Do not expose Admin portal role permissions via agent API
        if (isAdminPortalRoleId(roleId)) {
            throw new ValidationError(
                'Zone Admin permissions are managed in the Admin panel only'
            );
        }

        const getPermissions = await permissions.findAll({
            where: {
                roleId: roleId
            },
            include: [
                {
                    model: features,
                    attributes: ['id', 'title', 'status'],
                    where: {
                        featureOf: { [Op.in]: [...AGENT_APP_FEATURE_OF] },
                    },
                    required: false,
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

    async addClassifiedAs(data) {
        const { name } = data;

        const createData = await classifiedAs.create({
            name,
        });

        return {
            createData,
        };
    }

    async getClassifiedAs() {
        // Agent app only needs Laundry Shop Employee (1), not Admin Employee (2)
        const getClassifiedAs = await classifiedAs.findAll({
            where: { id: 1 },
            attributes: ["id", "name", "status"],
        });

        return {
            getClassifiedAs,
        };
    }

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

    async getFeatures() {
        const getFeatures = await features.findAll({
            where: {
                status: true,
                featureOf: { [Op.in]: [...AGENT_APP_FEATURE_OF] },
            },
            attributes: ["id", "title", "description", "status", "featureOf", "key"],
        });

        return {
            getFeatures,
        };
    }
}

module.exports = new AgentRolePermissionService();

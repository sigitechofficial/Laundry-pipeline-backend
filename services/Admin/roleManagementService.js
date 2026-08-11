const { roles, permissions, features } = require('../../models');
const { Op } = require('sequelize');
const { 
    ValidationError, 
    NotFoundError, 
    ConflictError,
} = require('../../middlewares/universalErrorHandler');
const {
    ALL_SYSTEM_ROLE_IDS,
    AGENT_SHOP_STAFF_ROLE_IDS,
    ADMIN_PORTAL_ROLE_IDS,
    SYSTEM_ROLE_NAMES,
    isSystemRoleId,
    isAgentShopRoleName,
    isAdminPortalRoleName,
    normalizeRoleName,
} = require('../../constants/systemRoles');

function buildPermissionRows(permissionRole, roleId) {
    if (!Array.isArray(permissionRole)) return [];

    const rows = [];

    for (const item of permissionRole) {
        const featureId = item?.id;
        const perms = item?.permissions || {};

        if (!featureId) continue;

        rows.push({
            featureId,
            roleId,
            create: perms.create === true || perms.write === true,
            read:   perms.read   === true,
            update: perms.update === true || perms.write === true,
            delete: perms.delete === true || perms.write === true,
        });
    }

    return rows;
}

function assertCanMutateRole(roleId, { allowPermissionReplace = false } = {}) {
    const id = Number(roleId);
    if (!isSystemRoleId(id)) return;

    // Shop staff roles (6/8) must never be renamed/deleted/permission-wiped from admin panel.
    if (AGENT_SHOP_STAFF_ROLE_IDS.includes(id)) {
        throw new ValidationError(
            `${SYSTEM_ROLE_NAMES[id] || 'Shop staff role'} is a system Agent employee role and cannot be modified here. Manage Agent shop staff roles separately.`
        );
    }

    // Zone Admin (7): allow permission matrix updates only when explicitly updating permissions;
    // block rename/delete via other paths.
    if (ADMIN_PORTAL_ROLE_IDS.includes(id) && !allowPermissionReplace) {
        throw new ValidationError(
            `${SYSTEM_ROLE_NAMES[id] || 'Admin portal role'} is a system Admin employee role and cannot be renamed or deleted`
        );
    }
}

function roleAudience(role) {
    const id = Number(role.id);
    if (AGENT_SHOP_STAFF_ROLE_IDS.includes(id) || isAgentShopRoleName(role.name)) {
        return 'agent_shop_staff';
    }
    if (ADMIN_PORTAL_ROLE_IDS.includes(id) || isAdminPortalRoleName(role.name)) {
        return 'admin_portal';
    }
    return 'custom';
}

class RoleManagementService {
    /**
     * Add a new role (custom admin-portal roles only — not shop Driver/Manager names).
     */
    async addRole(roleData) {
        const name = (roleData.name || '').trim();
        if (!name) {
            throw new ValidationError('Role name is required');
        }

        if (isAgentShopRoleName(name)) {
            throw new ConflictError(
                'Laundry Shop Driver and Manager are reserved Agent employee roles'
            );
        }
        if (isAdminPortalRoleName(name)) {
            throw new ConflictError(
                'Zone Admin is a reserved Admin employee system role'
            );
        }

        const roleExists = await roles.findOne({
            where: { name }
        });
        
        if (roleExists) {
            throw new ConflictError('Role with this name already exists');
        }

        if (Array.isArray(roleData.permissionRole) && roleData.permissionRole.length > 0) {
            const incomingFeatureIds = roleData.permissionRole
                .map(item => item?.id)
                .filter(Boolean);

            const existingFeatures = await features.findAll({
                where: { id: { [Op.in]: incomingFeatureIds } },
                attributes: ['id'],
            });

            const existingIds = existingFeatures.map(f => f.id);
            const missingIds  = incomingFeatureIds.filter(id => !existingIds.includes(id));

            if (missingIds.length > 0) {
                throw new ValidationError(
                    `The following feature IDs do not exist: ${missingIds.join(', ')}. ` +
                    `Please create the features first using /addfeatures before assigning permissions.`
                );
            }
        }

        const createData = {
            name,
            status: roleData.status !== undefined ? roleData.status : true
        };

        const roleCreate = await roles.create(createData);

        const permissionRows = buildPermissionRows(roleData.permissionRole, roleCreate.id);
        if (permissionRows.length) {
            await permissions.bulkCreate(permissionRows);
        }
        
        return roleCreate;
    }

    /**
     * Get all roles with audience tags so UI can separate Admin vs Agent staff roles.
     * @param {{audience?: 'admin_portal'|'agent_shop_staff'|'all'}} [opts]
     */
    async getAllRoles(opts = {}) {
        const audience = opts.audience || 'all';
        const getRoles = await roles.findAll({
            order: [['id', 'ASC']],
        });

        const tagged = getRoles.map((r) => {
            const plain = r.get ? r.get({ plain: true }) : { ...r };
            plain.audience = roleAudience(plain);
            plain.isSystem = isSystemRoleId(plain.id);
            return plain;
        });

        if (audience === 'admin_portal') {
            // Admin employees: Zone Admin + custom (never Driver/Manager).
            return tagged.filter((r) => r.audience !== 'agent_shop_staff');
        }
        if (audience === 'agent_shop_staff') {
            return tagged.filter((r) => r.audience === 'agent_shop_staff');
        }
        return tagged;
    }

    /**
     * Update role — system shop roles locked; Zone Admin may update permissions only.
     */
    async updateRole(roleId, updateData) {
        const roleExists = await roles.findOne({ where: { id: roleId } });
        if (!roleExists) {
            throw new NotFoundError('Role not found');
        }

        const replacingPermissions =
            Array.isArray(updateData.permissionRole) &&
            updateData.permissionRole.length > 0;

        if (AGENT_SHOP_STAFF_ROLE_IDS.includes(Number(roleId))) {
            throw new ValidationError(
                `${SYSTEM_ROLE_NAMES[Number(roleId)]} is an Agent employee system role and cannot be modified from Admin`
            );
        }

        if (ADMIN_PORTAL_ROLE_IDS.includes(Number(roleId))) {
            // Allow permission matrix refresh only; block rename.
            if (updateData.name && normalizeRoleName(updateData.name) !== normalizeRoleName(roleExists.name)) {
                throw new ValidationError('Zone Admin system role cannot be renamed');
            }
            if (!replacingPermissions && updateData.status === undefined) {
                assertCanMutateRole(roleId);
            }
        }

        const updateFields = { ...updateData };
        delete updateFields.permissionRole;
        // Never allow changing system role names via payload
        if (isSystemRoleId(roleId)) {
            delete updateFields.name;
        }

        if (Object.keys(updateFields).length > 0) {
            const updatedRole = await roles.update(
                updateFields,
                { where: { id: roleId } }
            );

            if (!updatedRole[0] && !replacingPermissions) {
                throw new ValidationError('Failed to update role');
            }
        }

        if (replacingPermissions) {
            if (AGENT_SHOP_STAFF_ROLE_IDS.includes(Number(roleId))) {
                throw new ValidationError(
                    'Cannot overwrite Agent shop staff role permissions from Admin'
                );
            }

            const incomingFeatureIds = updateData.permissionRole
                .map(item => item?.id)
                .filter(Boolean);

            const existingFeatures = await features.findAll({
                where: { id: { [Op.in]: incomingFeatureIds } },
                attributes: ['id'],
            });

            const existingIds = existingFeatures.map(f => f.id);
            const missingIds  = incomingFeatureIds.filter(id => !existingIds.includes(id));

            if (missingIds.length > 0) {
                throw new ValidationError(
                    `The following feature IDs do not exist: ${missingIds.join(', ')}. ` +
                    `Please create the features first using /addfeatures before assigning permissions.`
                );
            }

            await permissions.destroy({ where: { roleId } });
            const permissionRows = buildPermissionRows(updateData.permissionRole, roleId);
            if (permissionRows.length) {
                await permissions.bulkCreate(permissionRows);
            }
        }

        const updatedRoleData = await roles.findOne({ where: { id: roleId } });
        return updatedRoleData;
    }

    /**
     * Delete role — never delete system roles 6/7/8.
     */
    async deleteRole(roleId) {
        if (isSystemRoleId(roleId)) {
            throw new ValidationError(
                `Cannot delete system role ${SYSTEM_ROLE_NAMES[Number(roleId)] || roleId}`
            );
        }

        const roleToDelete = await roles.destroy({ where: { id: roleId } });
        
        if (!roleToDelete) {
            throw new NotFoundError('Role not found');
        }
        
        return { message: 'Role deleted successfully' };
    }

    async getAllPermissions() {
        const getPermissions = await permissions.findAll({
            order: [['createdAt', 'DESC']]
        });
        return getPermissions;
    }

    async addPermission(permissionData) {
        const { name, description } = permissionData;
        
        const permissionExists = await permissions.findOne({
            where: { name }
        });
        
        if (permissionExists) {
            throw new ConflictError('Permission with this name already exists');
        }
        
        const permissionCreate = await permissions.create({
            name,
            description
        });
        
        return permissionCreate;
    }
}

module.exports = new RoleManagementService();

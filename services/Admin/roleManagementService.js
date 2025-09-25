const { roles, permissions } = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');

class RoleManagementService {
    /**
     * Add a new role
     * @param {Object} roleData - Role data containing name and permissionRole
     * @returns {Object} Created role data
     */
    async addRole(roleData) {
        try {
            const { name, permissionRole } = roleData;
            
            // Check if role already exists
            const roleExists = await roles.findOne({
                where: { name }
            });
            
            if (roleExists) {
                throw new ValidationError('Role with this name already exists');
            }

            const roleCreate = await roles.create({
                name,
                permissionRole: JSON.stringify(permissionRole)
            });
            
            return roleCreate;
        } catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            throw new Error(`Add role error: ${error.message}`);
        }
    }

    /**
     * Get all roles
     * @returns {Array} List of all roles
     */
    async getAllRoles() {
        try {
            const getRoles = await roles.findAll({
                order: [['createdAt', 'DESC']]
            });
            return getRoles;
        } catch (error) {
            throw new Error(`Get roles error: ${error.message}`);
        }
    }

    /**
     * Update role
     * @param {number} roleId - Role ID
     * @param {Object} updateData - Role update data
     * @returns {Object} Updated role data
     */
    async updateRole(roleId, updateData) {
        try {
            const { name, permissionRole } = updateData;
            
            const roleExists = await roles.findOne({ where: { id: roleId } });
            if (!roleExists) {
                throw new NotFoundError('Role not found');
            }

            const updatedRole = await roles.update(
                { 
                    name, 
                    permissionRole: JSON.stringify(permissionRole) 
                },
                { where: { id: roleId } }
            );

            if (!updatedRole[0]) {
                throw new Error('Failed to update role');
            }

            const updatedRoleData = await roles.findOne({ where: { id: roleId } });
            return updatedRoleData;
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Update role error: ${error.message}`);
        }
    }

    /**
     * Delete role
     * @param {number} roleId - Role ID
     * @returns {Object} Deleted role data
     */
    async deleteRole(roleId) {
        try {
            const roleToDelete = await roles.destroy({ where: { id: roleId } });
            
            if (!roleToDelete) {
                throw new NotFoundError('Role not found');
            }
            
            return { message: 'Role deleted successfully' };
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Delete role error: ${error.message}`);
        }
    }

    /**
     * Get all permissions
     * @returns {Array} List of all permissions
     */
    async getAllPermissions() {
        try {
            const getPermissions = await permissions.findAll({
                order: [['createdAt', 'DESC']]
            });
            return getPermissions;
        } catch (error) {
            throw new Error(`Get permissions error: ${error.message}`);
        }
    }

    /**
     * Add permission
     * @param {Object} permissionData - Permission data containing name and description
     * @returns {Object} Created permission data
     */
    async addPermission(permissionData) {
        try {
            const { name, description } = permissionData;
            
            const permissionCreate = await permissions.create({
                name,
                description
            });
            
            return permissionCreate;
        } catch (error) {
            throw new Error(`Add permission error: ${error.message}`);
        }
    }
}

module.exports = new RoleManagementService();

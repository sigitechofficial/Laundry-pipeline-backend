const { roles, permissions } = require('../../models');
const { 
    ValidationError, 
    NotFoundError, 
    ConflictError,
    UnprocessableEntityError 
} = require('../../middlewares/universalErrorHandler');




class RoleManagementService {
    /**
     * Add a new role
     * @param {Object} roleData - Role data containing name and permissionRole
     * @returns {Object} Created role data
     */
    async addRole(roleData) {
        // Check if role already exists
        const roleExists = await roles.findOne({
            where: { name: roleData.name }
        });
        
        if (roleExists) {
            throw new ConflictError('Role with this name already exists');
        }

        const createData = { 
            ...roleData,
            status: roleData.status !== undefined ? roleData.status : true
        };
        if (createData.permissionRole) {
            createData.permissionRole = JSON.stringify(createData.permissionRole);
        }

        const roleCreate = await roles.create(createData);
        
        return roleCreate;
    }

    /**
     * Get all roles
     * @returns {Array} List of all roles
     */
    async getAllRoles() {
        const getRoles = await roles.findAll({
            order: [['createdAt', 'DESC']]
        });
        return getRoles;
    }

    /**
     * Update role
     * @param {number} roleId - Role ID
     * @param {Object} updateData - Role update data
     * @returns {Object} Updated role data
     */
    async updateRole(roleId, updateData) {
        const roleExists = await roles.findOne({ where: { id: roleId } });
        if (!roleExists) {
            throw new NotFoundError('Role not found');
        }

        const updateFields = { ...updateData };
        if (updateFields.permissionRole) {
            updateFields.permissionRole = JSON.stringify(updateFields.permissionRole);
        }

        const updatedRole = await roles.update(
            updateFields,
            { where: { id: roleId } }
        );

        if (!updatedRole[0]) {
            throw new ValidationError('Failed to update role');
        }

        const updatedRoleData = await roles.findOne({ where: { id: roleId } });
        return updatedRoleData;
    }

    /**
     * Delete role
     * @param {number} roleId - Role ID
     * @returns {Object} Deleted role data
     */
    async deleteRole(roleId) {
        const roleToDelete = await roles.destroy({ where: { id: roleId } });
        
        if (!roleToDelete) {
            throw new NotFoundError('Role not found');
        }
        
        return { message: 'Role deleted successfully' };
    }

    /**
     * Get all permissions
     * @returns {Array} List of all permissions
     */
    async getAllPermissions() {
        const getPermissions = await permissions.findAll({
            order: [['createdAt', 'DESC']]
        });
        return getPermissions;
    }

    /**
     * Add permission
     * @param {Object} permissionData - Permission data containing name and description
     * @returns {Object} Created permission data
     */
    async addPermission(permissionData) {
        const { name, description } = permissionData;
        
        // Check if permission already exists
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

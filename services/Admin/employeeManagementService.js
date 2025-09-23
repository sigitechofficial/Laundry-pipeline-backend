const { users } = require('../../models');

class EmployeeManagementService {
    /**
     * Get all admin employees
     * @returns {Object} List of admin employees
     */
    async getAdminEmployees() {
        try {
            const adminEmployees = await users.findAll({
                where: {
                    classifiedAsId: 2,
                    status: true
                },
                attributes: ['id', 'firstName', 'lastName', 'email', 'classifiedAsId', 'roleId', 'phoneNum', 'status']
            });

            return {
                adminEmployees: adminEmployees
            };
        } catch (error) {
            throw new Error(`Admin employees service error: ${error.message}`);
        }
    }
}

module.exports = new EmployeeManagementService();

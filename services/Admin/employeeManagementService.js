const { users, zone } = require('../../models');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');

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

    /**
     * Add new employee
     * @param {Object} employeeData - Employee data
     * @param {number} adminId - Admin ID who is creating the employee
     * @returns {Object} Created employee data
     */
    async addEmployee(employeeData, adminId) {
        try {
            const { firstName, lastName, email, password, phoneNum, roleId, zoneId } = employeeData;

            // Check if employee already exists
            const userFind = await users.findOne({
                where: {
                    classifiedAsId: 2,
                    roleId: roleId
                }
            });

            if (userFind) {
                throw new Error('Employee Already Exists');
            }

            // Hash password
            const hashpassword = await bcrypt.hash(password, 10);

            // Create employee
            const user = await users.create({
                firstName,
                lastName,
                email,
                password: hashpassword,
                phoneNum,
                roleId,
                status: true,
                classifiedAsId: 2,
                verifiedAt: Date.now()
            });

            // Handle zone admin assignment
            if (user.roleId === 7) {
                await users.update({
                    employeeOff: adminId
                }, { where: { id: adminId } });

                await zone.update({
                    zoneAdminId: user.id
                }, { where: { id: zoneId } });
            }

            // Handle driver assignment
            if (user.roleId === 6) {
                await users.update({
                    employeeOff: adminId
                }, { where: { id: adminId } });
            }

            return user;
        } catch (error) {
            throw new Error(`Add employee service error: ${error.message}`);
        }
    }

    /**
     * Update employee details
     * @param {Object} updateData - Employee update data
     * @returns {Object} Update result
     */
    async updateEmployee(updateData) {
        try {
            const { firstName, lastName, email, phoneNum, roleId, updatePassword, employeeId } = updateData;

            // Check if email already exists for another employee
            const userExists = await users.findOne({
                where: {
                    email: email ? email : null,
                    id: { [Op.not]: employeeId },
                    classifiedAsId: 2
                }
            });

            if (userExists) {
                throw new Error('Employee with the following email exists. Please try another email');
            }

            const updateFields = {
                firstName,
                lastName,
                email,
                phoneNum,
                roleId
            };

            // Update password if provided
            if (updatePassword) {
                const hashpassword = await bcrypt.hash(updatePassword, 10);
                updateFields.password = hashpassword;
            }

            const result = await users.update(updateFields, {
                where: { id: employeeId }
            });

            return result;
        } catch (error) {
            throw new Error(`Update employee service error: ${error.message}`);
        }
    }

    /**
     * Change employee status
     * @param {number} employeeId - Employee ID
     * @param {boolean} status - New status
     * @returns {Object} Update result
     */
    async changeEmployeeStatus(employeeId, status) {
        try {
            const result = await users.update(
                { status },
                {
                    where: { id: employeeId }
                }
            );

            return result;
        } catch (error) {
            throw new Error(`Change employee status service error: ${error.message}`);
        }
    }
}

module.exports = new EmployeeManagementService();

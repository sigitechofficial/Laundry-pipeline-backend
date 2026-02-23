const { users, zone, addressDb, bussinessInformation, driverInZones, roles } = require('../../models');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');

class EmployeeManagementService {
    /**
     * Get all admin employees
     * @returns {Object} List of admin employees
     */
    async getAdminEmployees() {
        const adminEmployees = await users.findAll({
            where: {
                classifiedAsId: 2,
                status: true
            },
            attributes: ['id', 'firstName', 'lastName', 'email', 'classifiedAsId', 'roleId', 'phoneNum', 'status']
        });

        return {
            adminEmployees
        };
    }

    /**
     * Add new employee
     * @param {Object} employeeData - Employee data
     * @param {number} adminId - Admin ID who is creating the employee
     * @returns {Object} Created employee data
     */
    async addEmployee(employeeData, adminId) {
        try {
            // Check if employee already exists
            const userFind = await users.findOne({
                where: {
                    classifiedAsId: 2,
                    roleId: employeeData.roleId
                }
            });

            if (userFind) {
                throw new ValidationError('Employee Already Exists');
            }

            // Hash password if provided
            const createData = { ...employeeData };
            if (createData.password) {
                createData.password = await bcrypt.hash(createData.password, 10);
            }
            createData.status = true;
            createData.classifiedAsId = 2;
            createData.verifiedAt = Date.now();

            // Create employee
            const user = await users.create(createData);

            // Handle zone admin assignment
            if (user.roleId === 7 && employeeData.zoneId) {
                await users.update({
                    employeeOff: adminId
                }, { where: { id: adminId } });

                await zone.update({
                    zoneAdminId: user.id
                }, { where: { id: employeeData.zoneId } });
            }

            // Handle driver assignment
            if (user.roleId === 6) {
                await users.update({
                    employeeOff: adminId
                }, { where: { id: adminId } });
            }

            return user;
        } catch (error) {
            if (error instanceof ValidationError || error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Add employee error: ${error.message}`);
        }
    }

    /**
     * Update employee details
     * @param {Object} updateData - Employee update data
     * @returns {Object} Update result
     */
    async updateEmployee(updateData) {
        try {
            const { updatePassword, employeeId, ...updateFields } = updateData;

            // Check if email already exists for another employee
            if (updateFields.email) {
                const userExists = await users.findOne({
                    where: {
                        email: updateFields.email,
                        id: { [Op.not]: employeeId },
                        classifiedAsId: 2
                    }
                });

                if (userExists) {
                    throw new ValidationError('Employee with the following email exists. Please try another email');
                }
            }

            // Update password if provided
            if (updatePassword) {
                updateFields.password = await bcrypt.hash(updatePassword, 10);
            }

            const result = await users.update(updateFields, {
                where: { id: employeeId }
            });

            return result;
        } catch (error) {
            if (error instanceof ValidationError || error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Update employee error: ${error.message}`);
        }
    }

    /**
     * Change employee status
     * @param {number} employeeId - Employee ID
     * @param {boolean} status - New status
     * @returns {Object} Update result
     */
    async changeEmployeeStatus(employeeId, status) {
        const result = await users.update(
            { status },
            {
                where: { id: employeeId }
            }
        );

        return result;
    }

    /**
     * Add new agent employee
     * @param {Object} employeeData - Employee data
     * @param {string} profileImg - Profile image path
     * @param {number} agentId - Agent ID who is creating the employee
     * @returns {Object} Created employee data
     */
    async addAgentEmployee(employeeData, profileImg, agentId) {
        try {
            // Validate agentId
            if (!agentId) {
                throw new ValidationError('Agent ID is required');
            }

            // Check if employee already exists
            const userFind = await users.findOne({
                where: {
                    classifiedAsId: 1,
                    roleId: employeeData.roleId,
                    firstName: employeeData.firstName,
                    lastName: employeeData.lastName,
                    email: employeeData.email
                },
            });

            if (userFind) {
                throw new ValidationError('Employee Already Exists');
            }

            // Hash password if provided
            const createData = { ...employeeData };
            if (createData.password) {
                createData.password = await bcrypt.hash(createData.password, 10);
            }
            createData.status = true;
            createData.classifiedAsId = 1;
            createData.image = profileImg;
            createData.verifiedAt = Date.now();
            createData.employeeOff = agentId; // Set employeeOff during creation

            // Create employee
            const user = await users.create(createData);

            // Handle driver assignment and zone mapping
            if (user.roleId === 6) {
                const agentAddress = await addressDb.findOne({
                    where: {
                        userId: agentId,
                    },
                });

                if (agentAddress) {
                    const businessInfo = await bussinessInformation.findOne({
                        where: {
                            agentId: agentId,
                        },
                    });

                    const zoneId = agentAddress.zoneId;
                    const countryId = agentAddress.countryId;
                    const cityId = agentAddress.cityId;
                    const driverId = user.id;

                    await driverInZones.create({
                        driverId: driverId,
                        zoneId: zoneId,
                        laundaryShopId: businessInfo ? businessInfo.id : null,
                        countryId: countryId,
                        cityId: cityId,
                    });
                }
            }

            return user;
        } catch (error) {
            if (error instanceof ValidationError || error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Add agent employee error: ${error.message}`);
        }
    }

    /**
     * Update agent employee details
     * @param {Object} updateData - Employee update data
     * @param {string} profileImg - Profile image path
     * @returns {Object} Update result
     */
    async updateAgentEmployee(updateData, profileImg) {
        try {
            const { updatePassword, employeeId, ...updateFields } = updateData;

            // Validate employeeId
            if (!employeeId) {
                throw new ValidationError('Employee ID is required');
            }

            // Check if employee exists and is an agent employee
            const employee = await users.findOne({
                where: {
                    id: employeeId,
                    classifiedAsId: 1
                }
            });

            if (!employee) {
                throw new NotFoundError('Agent employee not found');
            }

            // Check if email already exists for another employee
            if (updateFields.email) {
                const userExists = await users.findOne({
                    where: {
                        email: updateFields.email,
                        id: { [Op.not]: employeeId },
                        classifiedAsId: 1,
                    },
                });

                if (userExists) {
                    throw new ValidationError('Employee with the following email exists. Please try another email');
                }
            }

            // Update password if provided
            if (updatePassword && updatePassword.trim() !== '') {
                updateFields.password = await bcrypt.hash(updatePassword, 10);
            }

            // Update profile image if provided
            if (profileImg) {
                updateFields.image = profileImg;
            }

            const result = await users.update(updateFields, {
                where: { id: employeeId },
            });

            return result;
        } catch (error) {
            if (error instanceof ValidationError || error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Update agent employee error: ${error.message}`);
        }
    }

    /**
     * Change agent employee status
     * @param {number} employeeId - Employee ID
     * @param {boolean} status - New status
     * @returns {Object} Update result
     */
    async changeAgentEmployeeStatus(employeeId, status) {
        try {
            // Validate employeeId
            if (!employeeId) {
                throw new ValidationError('Employee ID is required');
            }

            // Check if employee exists and is an agent employee
            const employee = await users.findOne({
                where: {
                    id: employeeId,
                    classifiedAsId: 1
                }
            });

            if (!employee) {
                throw new NotFoundError('Agent employee not found');
            }

            const result = await users.update(
                { status },
                {
                    where: { id: employeeId }
                }
            );

            return result;
        } catch (error) {
            if (error instanceof ValidationError || error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Change agent employee status error: ${error.message}`);
        }
    }

    /**
     * Get all agent employees
     * @param {number} agentId - Agent ID
     * @returns {Object} List of agent employees
     */
    async getAllAgentEmployees(agentId) {
        try {
            // Validate agentId
            if (!agentId) {
                throw new ValidationError('Agent ID is required');
            }

            const agentEmployee = await users.findAll({
                where: {
                    classifiedAsId: 1,
                    employeeOff: agentId
                },
                attributes: ["id", "firstName", "lastName", "email", "status", "phoneNum", 'image', 'roleId', 'employeeOff'],
                include: [
                    {
                        model: roles,
                        attributes: ["id", "name"],
                    },
                ],
            });

            return { agentEmployee };
        } catch (error) {
            if (error instanceof ValidationError || error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Get all agent employees error: ${error.message}`);
        }
    }
}

module.exports = new EmployeeManagementService();

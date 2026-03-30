const { users, zone, addressDb, bussinessInformation, driverInZones, roles } = require('../../models');
const { UniqueConstraintError, ValidationError: SequelizeValidationError, Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const { ValidationError, NotFoundError, ConflictError } = require('../../middlewares/universalErrorHandler');

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
     * Add new admin employee (zone admin or other staff)
     * Created employee can log in via the zoneAdminLogin API.
     * @param {Object} employeeData - Employee data
     * @param {number} adminId - Admin ID who is creating the employee
     * @returns {Object} Created employee data
     */
    async addEmployee(employeeData, adminId) {
        const { firstName, lastName, email, password, phoneNum, roleId, zoneId } = employeeData;

        // Validate required fields
        if (!firstName || !lastName || !email || !password || !roleId) {
            throw new ValidationError('firstName, lastName, email, password and roleId are all required');
        }

        // Check email is not already taken anywhere in the system
        const existingUser = await users.findOne({ where: { email } });
        if (existingUser) {
            throw new ConflictError('An account with this email already exists. Please use a different email.');
        }

        // If a zone is being assigned, validate it exists and is not already claimed
        if (zoneId) {
            const zoneRecord = await zone.findOne({ where: { id: zoneId } });
            if (!zoneRecord) {
                throw new NotFoundError('Zone not found. Please select a valid zone.');
            }
            if (zoneRecord.zoneAdminId) {
                throw new ConflictError('This zone already has an admin assigned. Please choose a different zone.');
            }
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create the employee — only pass valid users-table fields
        let user;
        try {
            user = await users.create({
                firstName,
                lastName,
                email,
                password: hashedPassword,
                phoneNum: phoneNum || null,
                roleId,
                userTypeId: 1,      // admin-side user
                classifiedAsId: 2,  // marks as employee (not super admin)
                status: true,
                verifiedAt: new Date(),
                employeeOff: adminId
            });
        } catch (dbError) {
            if (dbError instanceof UniqueConstraintError) {
                throw new ConflictError('An account with this email already exists. Please use a different email.');
            }
            if (dbError instanceof SequelizeValidationError) {
                const messages = dbError.errors.map(e => e.message).join(', ');
                throw new ValidationError(`Invalid data: ${messages}`);
            }
            throw dbError;
        }

        // Assign employee as zone admin if a zoneId was provided
        if (zoneId) {
            await zone.update(
                { zoneAdminId: user.id },
                { where: { id: zoneId } }
            );
        }

        return {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phoneNum: user.phoneNum,
            roleId: user.roleId,
            classifiedAsId: user.classifiedAsId,
            zoneId: zoneId || null
        };
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
     * Get specific admin employee details
     * @param {number} employeeId - Employee ID
     * @returns {Object} Admin employee detail
     */
    async getAdminEmployeeDetail(employeeId) {
        if (!employeeId) {
            throw new ValidationError('Employee ID is required');
        }

        const employee = await users.findOne({
            where: {
                id: employeeId,
                classifiedAsId: 2
            },
            attributes: ['id', 'firstName', 'lastName', 'email', 'classifiedAsId', 'roleId', 'phoneNum', 'status'],
            include: [
                {
                    model: roles,
                    attributes: ['id', 'name']
                }
            ]
        });

        if (!employee) {
            throw new NotFoundError('Admin employee not found');
        }

        return { employee };
    }

    /**
     * Update admin employee details
     * @param {Object} updateData - Employee update data
     * @returns {Object} Updated admin employee
     */
    async updateAdminEmployee(updateData) {
        const { updatePassword, employeeId, ...updateFields } = updateData;

        if (!employeeId) {
            throw new ValidationError('Employee ID is required');
        }

        const employee = await users.findOne({
            where: {
                id: employeeId,
                classifiedAsId: 2
            }
        });

        if (!employee) {
            throw new NotFoundError('Admin employee not found');
        }

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

        if (updatePassword && updatePassword.trim() !== '') {
            updateFields.password = await bcrypt.hash(updatePassword, 10);
        }

        await users.update(updateFields, {
            where: {
                id: employeeId,
                classifiedAsId: 2
            }
        });

        const updatedEmployee = await users.findOne({
            where: {
                id: employeeId,
                classifiedAsId: 2
            },
            attributes: ['id', 'firstName', 'lastName', 'email', 'classifiedAsId', 'roleId', 'phoneNum', 'status']
        });

        return { employee: updatedEmployee };
    }

    /**
     * Soft delete admin employee
     * @param {number} employeeId - Employee ID
     * @returns {Object} Deletion result
     */
    async deleteAdminEmployee(employeeId) {
        if (!employeeId) {
            throw new ValidationError('Employee ID is required');
        }

        const employee = await users.findOne({
            where: {
                id: employeeId,
                classifiedAsId: 2
            }
        });

        if (!employee) {
            throw new NotFoundError('Admin employee not found');
        }

        const result = await users.destroy({
            where: {
                id: employeeId,
                classifiedAsId: 2
            }
        });

        if (result === 0) {
            throw new NotFoundError('Admin employee not found or already deleted');
        }

        return {
            message: 'Admin employee deleted successfully',
            employeeId
        };
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

    /**
     * Soft delete agent employee
     * @param {number} employeeId - Employee ID
     * @returns {Object} Deletion result
     */
    async deleteAgentEmployee(employeeId) {
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

            // Soft delete the employee (sets deletedAt timestamp if paranoid is enabled)
            const result = await users.destroy({
                where: { id: employeeId }
            });

            if (result === 0) {
                throw new NotFoundError('Agent employee not found or already deleted');
            }

            return {
                message: 'Agent employee deleted successfully',
                employeeId
            };
        } catch (error) {
            if (error instanceof ValidationError || error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Delete agent employee error: ${error.message}`);
        }
    }
}

module.exports = new EmployeeManagementService();

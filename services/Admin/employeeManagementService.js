const { users, zone, addressDb, bussinessInformation, driverInZones, roles } = require('../../models');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');

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
            adminEmployees: adminEmployees
        };
    }

    /**
     * Add new employee
     * @param {Object} employeeData - Employee data
     * @param {number} adminId - Admin ID who is creating the employee
     * @returns {Object} Created employee data
     */
    async addEmployee(employeeData, adminId) {
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
    }

    /**
     * Update employee details
     * @param {Object} updateData - Employee update data
     * @returns {Object} Update result
     */
    async updateEmployee(updateData) {
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
        const { firstName, lastName, email, password, phoneNum, countryCode, roleId } = employeeData;

        // Check if employee already exists
        const userFind = await users.findOne({
            where: {
                classifiedAsId: 1,
                roleId: roleId,
                firstName: firstName,
                lastName: lastName,
                email
            },
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
            classifiedAsId: 1,
            image: profileImg,
            countryCode,
            verifiedAt: Date.now(),
        });

        // Handle agent employee assignment
        if (user.classifiedAsId === 1 || user.roleId === 6) {
            await users.update(
                {
                    employeeOff: agentId,
                },
                { where: { id: user.id } }
            );

            const agentAddress = await addressDb.findOne({
                where: {
                    userId: agentId,
                },
            });

            const businessInfo = await bussinessInformation.findOne({
                where: {
                    agentId: agentId,
                },
            });

            const zoneId = agentAddress.zoneId;
            const shopAddressId = agentAddress.id;
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

        return user;
    }

    /**
     * Update agent employee details
     * @param {Object} updateData - Employee update data
     * @param {string} profileImg - Profile image path
     * @returns {Object} Update result
     */
    async updateAgentEmployee(updateData, profileImg) {
        const { firstName, lastName, email, phoneNum, roleId, updatePassword, employeeId } = updateData;

        // Check if email already exists for another employee
        if (email) {
            const userExists = await users.findOne({
                where: {
                    email: email,
                    id: { [Op.not]: employeeId },
                    classifiedAsId: 1,
                },
            });

            if (userExists) {
                throw new Error('Employee with the following email exists. Please try another email');
            }
        }

        const updatedFields = {};

        if (firstName !== undefined) updatedFields.firstName = firstName;
        if (lastName !== undefined) updatedFields.lastName = lastName;
        if (email !== undefined) updatedFields.email = email;
        if (phoneNum !== undefined) updatedFields.phoneNum = phoneNum;
        if (roleId !== undefined) updatedFields.roleId = roleId;

        // Update password if provided
        if (updatePassword && updatePassword.trim() !== '') {
            const hashedPassword = await bcrypt.hash(updatePassword, 10);
            updatedFields.password = hashedPassword;
        }

        // Update profile image if provided
        if (profileImg) {
            updatedFields.image = profileImg;
        }

        const result = await users.update(updatedFields, {
            where: { id: employeeId },
        });

        return result;
    }

    /**
     * Change agent employee status
     * @param {number} employeeId - Employee ID
     * @param {boolean} status - New status
     * @returns {Object} Update result
     */
    async changeAgentEmployeeStatus(employeeId, status) {
        const result = await users.update(
            { status },
            {
                where: { id: employeeId }
            }
        );

        return result;
    }

    /**
     * Get all agent employees
     * @param {number} agentId - Agent ID
     * @returns {Object} List of agent employees
     */
    async getAllAgentEmployees(agentId) {
        const agentEmployee = await users.findAll({
            where: {
                classifiedAsId: 1,
                employeeOff: agentId
            },
            attributes: ["id", "firstName", "lastName", "email", "status", "phoneNum", 'image'],
            include: [
                {
                    model: roles,
                    attributes: ["id", "name"],
                },
            ],
        });

        return { agentEmployee };
    }
}

module.exports = new EmployeeManagementService();

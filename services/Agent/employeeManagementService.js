require("dotenv").config();
const { users, addressDb, bussinessInformation, driverInZones, roles } = require('../../models');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const { 
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError 
} = require('../../middlewares/universalErrorHandler');
const path = require('path');

/**
 * Agent Employee Management Service
 * Handles all agent employee related business logic
 */
class AgentEmployeeManagementService {

    /**
     * Add Employee
     * @param {Object} data - Employee data
     * @param {string} data.firstName - First name
     * @param {string} data.lastName - Last name
     * @param {string} data.email - Email
     * @param {string} data.password - Password
     * @param {string} data.phoneNum - Phone number
     * @param {string} data.countryCode - Country code
     * @param {number} data.roleId - Role ID
     * @param {string} profileImg - Profile image path
     * @param {number} agentId - Agent ID
     * @returns {Object} Employee creation result
     */
    async addEmployee(data, profileImg, agentId) {
        const {
            firstName,
            lastName,
            email,
            password,
            phoneNum,
            countryCode,
            roleId,
        } = data;

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
            throw new ConflictError("Employee Already Exists");
        }

        const hashpassword = await bcrypt.hash(password, 10);

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

        return {
            user,
            message: "Employee Added Successfully"
        };
    }

    /**
     * Update Employee
     * @param {Object} data - Update employee data
     * @param {string} data.firstName - First name
     * @param {string} data.lastName - Last name
     * @param {string} data.email - Email
     * @param {string} data.phoneNum - Phone number
     * @param {number} data.roleId - Role ID
     * @param {string} data.updatePassword - New password
     * @param {number} data.employeeId - Employee ID
     * @param {string} profileImg - Profile image path
     * @returns {Object} Update result
     */
    async updateEmployee(data, profileImg) {
        const {
            firstName,
            lastName,
            email,
            phoneNum,
            roleId,
            updatePassword,
            employeeId
        } = data;

        if (email) {
            const userExists = await users.findOne({
                where: {
                    email: email,
                    id: { [Op.not]: employeeId },
                    classifiedAsId: 1,
                },
            });

            if (userExists) {
                throw new ConflictError(
                    "Employee with the following email exists",
                    { message: "Please try another email" }
                );
            }
        }

        const updatedFields = {};

        if (firstName !== undefined) updatedFields.firstName = firstName;
        if (lastName !== undefined) updatedFields.lastName = lastName;
        if (email !== undefined) updatedFields.email = email;
        if (phoneNum !== undefined) updatedFields.phoneNum = phoneNum;
        if (roleId !== undefined) updatedFields.roleId = roleId;

        if (updatePassword && updatePassword.trim() !== '') {
            const hashedPassword = await bcrypt.hash(updatePassword, 10);
            updatedFields.password = hashedPassword;
        }

        if (profileImg) {
            updatedFields.image = profileImg;
        }

        const result = await users.update(updatedFields, {
            where: { id: employeeId },
        });

        return {
            result,
            message: "Employee Updated Successfully"
        };
    }

    /**
     * Change Employee Status
     * @param {Object} data - Status change data
     * @param {number} data.employeeId - Employee ID
     * @param {boolean} data.status - New status
     * @returns {Object} Status update result
     */
    async changeEmployeeStatus(data) {
        const { employeeId, status } = data;

        const result = await users.update(
            { status },
            {
                where: { id: employeeId }
            }
        );

        return {
            result,
            message: "Employee Status Updated"
        };
    }

    /**
     * Get All Employees
     * @param {number} agentId - Agent ID
     * @returns {Object} All employees data
     */
    async getAllEmployees(agentId) {
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

        return {
            agentEmployee,
            message: "All Employee Fetched"
        };
    }
}

module.exports = new AgentEmployeeManagementService();

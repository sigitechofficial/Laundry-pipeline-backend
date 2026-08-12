require("dotenv").config();
const {
    users,
    addressDb,
    bussinessInformation,
    driverInZones,
    roles,
    booking,
    sequelize,
} = require('../../models');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const {
    UnauthorizedError,
    NotFoundError,
    ConflictError,
    ValidationError,
} = require('../../middlewares/universalErrorHandler');
const path = require('path');
const {
    LAUNDRY_SHOP_DRIVER_ROLE_ID,
    LAUNDRY_SHOP_MANAGER_ROLE_ID,
} = require('../../utils/shopAgentContext');
const {
    CLASSIFIED_AS,
} = require('../../constants/systemRoles');

function isLaundryShopDriverRole(roleRecord) {
    if (!roleRecord) {
        return false;
    }
    const name = (roleRecord.name || '').trim().toLowerCase();
    return (
        name === 'laundry shop driver' ||
        Number(roleRecord.id) === LAUNDRY_SHOP_DRIVER_ROLE_ID
    );
}

function isLaundryShopManagerRole(roleRecord) {
    if (!roleRecord) {
        return false;
    }
    const name = (roleRecord.name || '').trim().toLowerCase();
    return (
        name === 'laundry shop manager' ||
        Number(roleRecord.id) === LAUNDRY_SHOP_MANAGER_ROLE_ID
    );
}

function toPublicEmployee(user) {
    const plain = user.get ? user.get({ plain: true }) : { ...user };
    delete plain.password;
    return plain;
}

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
     * @param {number} data.roleId - Role ID (6 Driver or 8 Manager only)
     * @param {string} profileImg - Profile image path
     * @param {number} agentId - Agent ID
     * @returns {Object} Employee creation result (no password in payload)
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

        if (
            !firstName?.trim() ||
            !lastName?.trim() ||
            !email?.trim() ||
            !password ||
            roleId === undefined ||
            roleId === null ||
            roleId === ''
        ) {
            throw new ValidationError(
                'firstName, lastName, email, password, and roleId are required'
            );
        }

        const numericRoleId = parseInt(roleId, 10);
        if (Number.isNaN(numericRoleId)) {
            throw new ValidationError('roleId must be a valid number');
        }

        // permissionRole on add-employee is ignored — shared role permissions (6/8)
        // must not be overwritten per shop. Use admin role-permission tools instead.

        const t = await sequelize.transaction();

        try {
            const roleRecord = await roles.findByPk(numericRoleId, {
                transaction: t,
                attributes: ['id', 'name', 'status'],
            });

            if (!roleRecord || !roleRecord.status) {
                throw new ValidationError('Invalid or inactive role');
            }

            if (
                !isLaundryShopDriverRole(roleRecord) &&
                !isLaundryShopManagerRole(roleRecord)
            ) {
                throw new ValidationError(
                    'Employees must use Laundry Shop Driver or Laundry Shop Manager role'
                );
            }

            const existingSameShop = await users.findOne({
                where: {
                    email: email.trim(),
                    classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE,
                    employeeOff: agentId,
                },
                transaction: t,
            });

            if (existingSameShop) {
                throw new ConflictError(
                    'An employee with this email already exists for your shop'
                );
            }

            const existingEmail = await users.findOne({
                where: { email: email.trim() },
                transaction: t,
            });

            if (existingEmail) {
                throw new ConflictError(
                    'This email is already registered. Use a different email.'
                );
            }

            const hashpassword = await bcrypt.hash(password, 10);
            const isDriver = isLaundryShopDriverRole(roleRecord);

            const user = await users.create(
                {
                    firstName: firstName.trim(),
                    lastName: lastName.trim(),
                    email: email.trim(),
                    password: hashpassword,
                    phoneNum,
                    roleId: numericRoleId,
                    status: true,
                    classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE,
                    image: profileImg,
                    countryCode,
                    verifiedAt: Date.now(),
                    employeeOff: agentId,
                    ...(isDriver ? { driverType: 'laundary Shop Driver' } : {}),
                },
                { transaction: t }
            );

            if (isDriver) {
                const agentAddress = await addressDb.findOne({
                    where: { userId: agentId },
                    transaction: t,
                });

                if (!agentAddress || agentAddress.zoneId == null) {
                    throw new ValidationError(
                        'Shop address or zone is missing. Add your shop address before adding a laundry driver.'
                    );
                }

                const businessInfo = await bussinessInformation.findOne({
                    where: { agentId },
                    transaction: t,
                });

                await driverInZones.create(
                    {
                        driverId: user.id,
                        zoneId: agentAddress.zoneId,
                        laundaryShopId: businessInfo ? businessInfo.id : null,
                        countryId: agentAddress.countryId,
                        cityId: agentAddress.cityId,
                    },
                    { transaction: t }
                );
            }

            await t.commit();

            const fresh = await users.findByPk(user.id, {
                attributes: {
                    exclude: ['password'],
                },
                include: [
                    {
                        model: roles,
                        attributes: ['id', 'name'],
                    },
                ],
            });

            return {
                message: 'Employee added successfully',
                data: {
                    employee: fresh ? toPublicEmployee(fresh) : toPublicEmployee(user),
                    permissionsUpdated: false,
                    roleId: numericRoleId,
                },
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
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
    async _assertOwnedEmployee(agentId, employeeId) {
        if (!employeeId) {
            throw new ValidationError('Employee ID is required');
        }
        const employee = await users.findOne({
            where: {
                id: employeeId,
                classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE,
                employeeOff: agentId,
            },
        });
        if (!employee) {
            throw new NotFoundError('Employee not found in your shop');
        }
        return employee;
    }

    async updateEmployee(data, profileImg, agentId) {
        const {
            firstName,
            lastName,
            email,
            phoneNum,
            roleId,
            updatePassword,
            employeeId
        } = data;

        await this._assertOwnedEmployee(agentId, employeeId);

        if (roleId !== undefined && roleId !== null && roleId !== '') {
            const numericRoleId = parseInt(roleId, 10);
            if (Number.isNaN(numericRoleId)) {
                throw new ValidationError('roleId must be a valid number');
            }
            const roleRecord = await roles.findByPk(numericRoleId, {
                attributes: ['id', 'name', 'status'],
            });
            if (!roleRecord || !roleRecord.status) {
                throw new ValidationError('Invalid or inactive role');
            }
            if (
                !isLaundryShopDriverRole(roleRecord) &&
                !isLaundryShopManagerRole(roleRecord)
            ) {
                throw new ValidationError(
                    'Employees must use Laundry Shop Driver or Laundry Shop Manager role'
                );
            }
        }

        if (email) {
            const userExists = await users.findOne({
                where: {
                    email: email,
                    id: { [Op.not]: employeeId },
                    classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE,
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
            where: { id: employeeId, employeeOff: agentId, classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE },
        });

        return {
            result,
        };
    }

    /**
     * Change Employee Status
     * @param {Object} data - Status change data
     * @param {number} data.employeeId - Employee ID
     * @param {boolean} data.status - New status
     * @param {number} agentId - Shop owner id
     * @returns {Object} Status update result
     */
    async changeEmployeeStatus(data, agentId) {
        const { employeeId, status } = data;

        await this._assertOwnedEmployee(agentId, employeeId);

        const result = await users.update(
            { status },
            {
                where: { id: employeeId, employeeOff: agentId, classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE },
            }
        );

        return {
            result,
            message: status ? 'Employee activated' : 'Employee deactivated',
        };
    }

    /**
     * Soft-delete an employee belonging to this shop.
     * Active job assignments are returned to the shop owner.
     */
    async deleteEmployee(employeeId, agentId) {
        await this._assertOwnedEmployee(agentId, employeeId);

        await booking.update(
            { driverId: agentId },
            { where: { driverId: employeeId } }
        );
        await booking.update(
            { deliveryDriverId: agentId },
            { where: { deliveryDriverId: employeeId } }
        );

        await driverInZones.destroy({
            where: { driverId: employeeId },
        });

        const result = await users.destroy({
            where: {
                id: employeeId,
                employeeOff: agentId,
                classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE,
            },
        });

        if (!result) {
            throw new NotFoundError('Employee not found or already deleted');
        }

        return {
            message: 'Employee removed successfully',
            employeeId: Number(employeeId),
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
                classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE,
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
        };
    }
}

module.exports = new AgentEmployeeManagementService();

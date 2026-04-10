require("dotenv").config();
const {
    users,
    addressDb,
    bussinessInformation,
    driverInZones,
    roles,
    permissions,
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

/** Seeded id for "Laundry Shop Driver" — also matched by role name (case-insensitive). */
const LAUNDRY_SHOP_DRIVER_ROLE_ID = 6;

function parsePermissionRole(raw) {
    if (raw == null || raw === '') {
        return [];
    }
    if (Array.isArray(raw)) {
        return raw;
    }
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

function buildPermissionRows(permissionRole, roleId) {
    return (permissionRole || [])
        .filter((ele) => ele?.id)
        .map((ele) => {
            const perms = ele?.permissions || {};
            return {
                featureId: ele.id,
                roleId,
                create: perms.create === true || perms.write === true,
                read: perms.read === true,
                update: perms.update === true || perms.write === true,
                delete: perms.delete === true || perms.write === true,
            };
        });
}

function isLaundryShopDriverRole(roleRecord) {
    if (!roleRecord) {
        return false;
    }
    const name = (roleRecord.name || '').trim().toLowerCase();
    return (
        name === 'laundry shop driver' ||
        roleRecord.id === LAUNDRY_SHOP_DRIVER_ROLE_ID
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
     * @param {number} data.roleId - Role ID
     * @param {Array|string} [data.permissionRole] - Optional: sync role permissions (feature id + permissions); JSON string ok for multipart
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
            permissionRole: permissionRoleRaw,
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

        const permissionRole = parsePermissionRole(permissionRoleRaw);
        const permissionRows = buildPermissionRows(permissionRole, numericRoleId);

        const t = await sequelize.transaction();

        try {
            const roleRecord = await roles.findByPk(numericRoleId, {
                transaction: t,
                attributes: ['id', 'name', 'status'],
            });

            if (!roleRecord || !roleRecord.status) {
                throw new ValidationError('Invalid or inactive role');
            }

            const existingSameShop = await users.findOne({
                where: {
                    email: email.trim(),
                    classifiedAsId: 1,
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
                    classifiedAsId: 1,
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

            let permissionsUpdated = false;
            if (permissionRows.length > 0) {
                await permissions.destroy({
                    where: { roleId: numericRoleId },
                    transaction: t,
                });
                await permissions.bulkCreate(permissionRows, { transaction: t });
                permissionsUpdated = true;
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
                    permissionsUpdated,
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
        };
    }
}

module.exports = new AgentEmployeeManagementService();

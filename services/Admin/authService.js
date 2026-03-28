const { users, features, zone, permissions } = require('../../models');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const redisCli = require('../../redis/redis');

// Universal error handling
const { 
    ValidationError, 
    NotFoundError, 
    UnauthorizedError, 
    ConflictError 
} = require('../../middlewares/universalErrorHandler');

class AuthService {
    /**
     * Admin sign in
     * @param {Object} signInData - Sign in data containing email, password, and device token
     * @returns {Object} Admin data with access token and features
     */
    async adminSignIn(signInData) {
            const { email, password, dvToken } = signInData;

            // Find the admin data based on email, status, and userTypeId
            const adminData = await users.findOne({
                where: {
                    email,
                    status: true,
                    userTypeId: 1
                },
            });

            if (!adminData) {
                throw new NotFoundError('User not found. Please enter valid credentials.');
            }

            // Verify password
            const match = await bcrypt.compare(password, adminData.password);
            if (!match) {
                throw new UnauthorizedError('Invalid credentials. Please enter the correct password.');
            }

            // Update device token if provided
            if (dvToken) {
                await users.update({ dvToken }, { where: { id: adminData.id } });
            }

            // Get admin features
            const featureData = await features.findAll({
                where: {
                    status: true,
                },
                attributes: ['id', 'title']
            });

            // Get zone information if admin is a zone admin
            const zoneAdminFind = await zone.findOne({
                where: {
                    zoneAdminId: adminData.id
                },
                attributes: ['id', 'name']
            });

            const zoneId = zoneAdminFind?.id;

            // Create JWT payload
            const payload = {
                id: adminData.id,
                email: adminData.email,
                dvToken: dvToken,
                zoneId: zoneId || "",
            };

            // Generate access token
            const accessToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET);

            // Store token in Redis
            if (dvToken) {
                await redisCli.hSet(`tsh${adminData.id}`, { [dvToken]: accessToken });
            }

            // Prepare response data
            const output = {
                id: adminData.id,
                name: adminData.name,
                email: adminData.email,
                accessToken,
                userName: adminData.companyName,
                featureData: featureData,
                zoneId: zoneId
            };

            return output;
    }

    /**
     * Zone Admin sign in
     * Zone admins are users with userTypeId 1 who have a zone assigned to them (zoneAdminId)
     * and have a classifiedAsId + roleId set for permission checking.
     * @param {Object} signInData - { email, password, dvToken }
     * @returns {Object} Zone admin data with accessToken, zone info and feature permissions
     */
    async zoneAdminSignIn(signInData) {
        const { email, password, dvToken } = signInData;

        if (!email || !password) {
            throw new ValidationError('Email and password are required');
        }

        if (!dvToken) {
            throw new ValidationError('Device token is required');
        }

        // Find the user
        const adminData = await users.findOne({
            where: {
                email,
                status: true,
                userTypeId: 1
            },
            attributes: ['id', 'firstName', 'lastName', 'email', 'password', 'classifiedAsId', 'roleId', 'userTypeId']
        });

        if (!adminData) {
            throw new NotFoundError('User not found. Please enter valid credentials.');
        }

        // Zone admin must have a classifiedAsId (not the super admin)
        if (!adminData.classifiedAsId) {
            throw new UnauthorizedError('This account is not a zone admin. Please use the admin login.');
        }

        // Verify password
        const match = await bcrypt.compare(password, adminData.password);
        if (!match) {
            throw new UnauthorizedError('Invalid credentials. Please enter the correct password.');
        }

        // Find the zone assigned to this admin
        const zoneData = await zone.findOne({
            where: { zoneAdminId: adminData.id },
            attributes: ['id', 'name']
        });

        if (!zoneData) {
            throw new NotFoundError('No zone is assigned to this admin account. Please contact the super admin.');
        }

        // Get features this zone admin's role has access to
        const permissionData = await permissions.findAll({
            where: { roleId: adminData.roleId },
            attributes: ['featureId', 'create', 'read', 'update', 'delete'],
            include: [{
                model: features,
                where: { status: true },
                attributes: ['id', 'title', 'key', 'featureOf']
            }]
        });

        // Build JWT payload
        const payload = {
            id: adminData.id,
            email: adminData.email,
            dvToken,
            zoneId: zoneData.id,
            classifiedAsId: adminData.classifiedAsId,
            roleId: adminData.roleId
        };

        const accessToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET);

        // Store in Redis
        await redisCli.hSet(`tsh${adminData.id}`, { [dvToken]: accessToken });

        return {
            id: adminData.id,
            firstName: adminData.firstName,
            lastName: adminData.lastName,
            email: adminData.email,
            accessToken,
            zoneId: zoneData.id,
            zoneName: zoneData.name,
            roleId: adminData.roleId,
            classifiedAsId: adminData.classifiedAsId,
            permissions: permissionData
        };
    }

    /**
     * Admin sign out
     * @param {number} adminId - Admin ID
     * @param {string} dvToken - Device token
     * @returns {boolean} Success status
     */
    async adminSignOut(adminId, dvToken) {
        try {
            // Remove token from Redis
            await redisCli.hDel(`tsh${adminId}`, dvToken);
            return true;
        } catch (error) {
            throw new ValidationError('Failed to sign out. Please try again.');
        }
    }

}

module.exports = new AuthService();
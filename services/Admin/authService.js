const { users, features, zone, permissions, deviceToken } = require('../../models');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const redisCli = require('../../redis/redis');
const { Op } = require('sequelize');
const { isValidFcmRegistrationToken } = require('../../utils/fcmToken');

// Universal error handling
const { 
    ValidationError, 
    NotFoundError, 
    UnauthorizedError, 
    ConflictError 
} = require('../../middlewares/universalErrorHandler');

/**
 * Persist FCM registration for push. Session/redis may still use a placeholder dvToken.
 */
async function upsertAdminFcmToken(userId, dvToken) {
    const trimmed = typeof dvToken === 'string' ? dvToken.trim() : '';
    if (!isValidFcmRegistrationToken(trimmed)) {
        await deviceToken.destroy({
            where: {
                userId,
                tokenId: { [Op.in]: ['no-fcm-token', trimmed].filter(Boolean) },
            },
        }).catch(() => {});
        return false;
    }
    await users.update({ dvToken: trimmed }, { where: { id: userId } });
    await deviceToken.destroy({ where: { userId } });
    await deviceToken.create({
        tokenId: trimmed,
        status: true,
        userId,
    });
    return true;
}

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

            // Only store real FCM tokens for push; placeholders stay session-only (Redis)
            if (dvToken) {
                await upsertAdminFcmToken(adminData.id, dvToken);
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

            // Store token in Redis (session key — may be placeholder)
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
                zoneId: zoneId,
                fcmRegistered: isValidFcmRegistrationToken(dvToken),
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
                classifiedAsId: 2
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

        // Find the zone assigned to this employee (optional — only zone admins have one)
        const zoneData = await zone.findOne({
            where: { zoneAdminId: adminData.id },
            attributes: ['id', 'name']
        });

        // Get permissions for this employee's role
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
            zoneId: zoneData ? zoneData.id : null,
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
            zoneId: zoneData ? zoneData.id : null,
            zoneName: zoneData ? zoneData.name : null,
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

    /**
     * Register / refresh FCM token for an already-logged-in admin (Alert Settings).
     */
    async registerFcmToken(adminId, dvToken) {
        if (!adminId) {
            throw new ValidationError('Admin id required');
        }
        if (!isValidFcmRegistrationToken(dvToken)) {
            throw new ValidationError(
                'No valid FCM token. Allow browser notifications, open the site over HTTPS, then try again.'
            );
        }
        const ok = await upsertAdminFcmToken(adminId, dvToken);
        return {
            registered: ok,
            tokenPreview: `${String(dvToken).trim().slice(0, 12)}…${String(dvToken).trim().slice(-8)}`,
        };
    }

}

module.exports = new AuthService();
module.exports.upsertAdminFcmToken = upsertAdminFcmToken;
module.exports.isValidFcmRegistrationToken = isValidFcmRegistrationToken;
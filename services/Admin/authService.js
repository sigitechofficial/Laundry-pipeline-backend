const { users, features, zone } = require('../../models');
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
                    featureOf: 'Admin'
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
            redisCli.hSet(`tsh${adminData.id}`, dvToken, accessToken);

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
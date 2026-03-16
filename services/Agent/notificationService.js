const { booking, users } = require('../../models');
const { sendNotification } = require('../../utils/notification');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { Op } = require('sequelize');

/**
 * Send notification to customer by booking ID
 * @param {string} bookingId - The booking ID
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Additional data to send with notification
 * @returns {object} Notification result
 */
async function sendNotificationToCustomer(bookingId, title, body, data = {}) {
    try {
        const bookingRecord = await booking.findOne({
            where: { id: bookingId },
            include: [{
                model: users,
                as: 'customer',
                attributes: ['id', 'firstName', 'lastName', 'email']
            }]
        });

        if (!bookingRecord) {
            throw new NotFoundError(`Booking with ID ${bookingId} not found`);
        }

        if (!bookingRecord.customer) {
            throw new NotFoundError(`Customer not found for booking ${bookingId}`);
        }

        const customerId = bookingRecord.customer.id;

        const notificationData = {
            bookingId,
            ...data
        };

        const result = await sendNotification(
            customerId,
            title,
            body,
            notificationData
        );

        return {
            success: result.sent,
            customerId,
            customerName: `${bookingRecord.customer.firstName} ${bookingRecord.customer.lastName}`,
            notificationResult: result
        };
    } catch (error) {
        console.error('Error in sendNotificationToCustomer:', error);
        throw error;
    }
}

/**
 * Send notification to admin(s)
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Additional data to send with notification
 * @param {string} adminId - Optional specific admin ID, if not provided sends to all admins
 * @returns {object} Notification results
 */
async function sendNotificationToAdmin(title, body, data = {}, adminId = null) {
    try {
        let admins;

        if (adminId) {
            const admin = await users.findOne({
                where: {
                    id: adminId,
                    userTypeId: 1,
                    status: true
                }
            });

            if (!admin) {
                throw new NotFoundError(`Admin with ID ${adminId} not found`);
            }

            admins = [admin];
        } else {
            admins = await users.findAll({
                where: {
                    userTypeId: 1,
                    status: true
                },
                attributes: ['id', 'firstName', 'lastName', 'email']
            });

            if (!admins || admins.length === 0) {
                throw new NotFoundError('No active admins found');
            }
        }

        const results = [];
        for (const admin of admins) {
            try {
                const result = await sendNotification(
                    admin.id,
                    title,
                    body,
                    data
                );

                results.push({
                    adminId: admin.id,
                    adminName: `${admin.firstName} ${admin.lastName}`,
                    success: result.sent,
                    result
                });
            } catch (error) {
                console.error(`Failed to send notification to admin ${admin.id}:`, error);
                results.push({
                    adminId: admin.id,
                    adminName: `${admin.firstName} ${admin.lastName}`,
                    success: false,
                    error: error.message
                });
            }
        }

        return {
            totalAdmins: admins.length,
            successCount: results.filter(r => r.success).length,
            results
        };
    } catch (error) {
        console.error('Error in sendNotificationToAdmin:', error);
        throw error;
    }
}

/**
 * Send notification to zone admin by booking ID
 * @param {string} bookingId - The booking ID
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Additional data to send with notification
 * @returns {object} Notification result
 */
async function sendNotificationToZoneAdmin(bookingId, title, body, data = {}) {
    try {
        const bookingRecord = await booking.findOne({
            where: { id: bookingId },
            include: [{
                model: users,
                as: 'customer',
                include: [{
                    model: require('../../models').zone,
                    as: 'customerZone',
                    include: [{
                        model: users,
                        as: 'zoneAdmin',
                        attributes: ['id', 'firstName', 'lastName', 'email']
                    }]
                }]
            }]
        });

        if (!bookingRecord) {
            throw new NotFoundError(`Booking with ID ${bookingId} not found`);
        }

        const zoneAdminId = bookingRecord.zoneId;
        if (!zoneAdminId) {
            throw new NotFoundError(`Zone admin not found for booking ${bookingId}`);
        }

        const zoneAdmin = await users.findOne({
            where: {
                id: zoneAdminId,
                status: true
            }
        });

        if (!zoneAdmin) {
            throw new NotFoundError(`Zone admin with ID ${zoneAdminId} not found or inactive`);
        }

        const notificationData = {
            bookingId,
            ...data
        };

        const result = await sendNotification(
            zoneAdminId,
            title,
            body,
            notificationData
        );

        return {
            success: result.sent,
            zoneAdminId,
            zoneAdminName: `${zoneAdmin.firstName} ${zoneAdmin.lastName}`,
            notificationResult: result
        };
    } catch (error) {
        console.error('Error in sendNotificationToZoneAdmin:', error);
        throw error;
    }
}

/**
 * Send notification to multiple recipients (customer, admin, zone admin)
 * @param {string} bookingId - The booking ID
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} options - Options for notification
 * @param {boolean} options.toCustomer - Send to customer
 * @param {boolean} options.toAdmin - Send to all admins
 * @param {boolean} options.toZoneAdmin - Send to zone admin
 * @param {object} data - Additional data to send with notification
 * @returns {object} Notification results
 */
async function sendNotificationToMultiple(bookingId, title, body, options = {}, data = {}) {
    const {
        toCustomer = false,
        toAdmin = false,
        toZoneAdmin = false
    } = options;

    const results = {
        customer: null,
        admin: null,
        zoneAdmin: null
    };

    try {
        if (toCustomer) {
            try {
                results.customer = await sendNotificationToCustomer(bookingId, title, body, data);
            } catch (error) {
                console.error('Failed to send to customer:', error);
                results.customer = { success: false, error: error.message };
            }
        }

        if (toAdmin) {
            try {
                results.admin = await sendNotificationToAdmin(title, body, { bookingId, ...data });
            } catch (error) {
                console.error('Failed to send to admin:', error);
                results.admin = { success: false, error: error.message };
            }
        }

        if (toZoneAdmin) {
            try {
                results.zoneAdmin = await sendNotificationToZoneAdmin(bookingId, title, body, data);
            } catch (error) {
                console.error('Failed to send to zone admin:', error);
                results.zoneAdmin = { success: false, error: error.message };
            }
        }

        return {
            success: true,
            results
        };
    } catch (error) {
        console.error('Error in sendNotificationToMultiple:', error);
        throw error;
    }
}

module.exports = {
    sendNotificationToCustomer,
    sendNotificationToAdmin,
    sendNotificationToZoneAdmin,
    sendNotificationToMultiple
};

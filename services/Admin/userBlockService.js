'use strict';
/**
 * Admin block/unblock + anonymize-on-delete for any user type.
 *
 * Block/unblock: sets users.status (false = blocked, true = active).
 * All login flows (customer, agent, driver, admin) already gate on status, so
 * flipping it is sufficient to bar/restore access immediately.
 *
 * Anonymize: scrambles PII before soft-deleting so GDPR/data-minimisation is
 * respected while booking history (foreign-key references) stays intact.
 */
const crypto = require('crypto');
const { users, booking } = require('../../models');
const { Op } = require('sequelize');
const {
    NotFoundError,
    UnprocessableEntityError,
    ValidationError,
} = require('../../middlewares/universalErrorHandler');
const { CLASSIFIED_AS, SYSTEM_ROLES } = require('../../constants/systemRoles');

// User type identifiers accepted in the API
const USER_TYPES = Object.freeze({
    customer: 'customer',
    driver: 'driver',
    agent: 'agent',
    agent_employee: 'agent_employee',
    admin_employee: 'admin_employee',
});

/** Build a Sequelize WHERE clause that targets the right user type. */
function whereForType(userId, userType) {
    const id = Number(userId);
    switch (userType) {
        case USER_TYPES.customer:
            return { id, userTypeId: 2 };
        case USER_TYPES.driver:
            return { id, roleId: SYSTEM_ROLES.LAUNDRY_SHOP_DRIVER, classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE };
        case USER_TYPES.agent:
            return { id, userTypeId: 3 };
        case USER_TYPES.agent_employee:
            return { id, classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE };
        case USER_TYPES.admin_employee:
            return { id, classifiedAsId: CLASSIFIED_AS.ADMIN_EMPLOYEE };
        default:
            // fallback — match by id only
            return { id };
    }
}

/** Short random hex for anonymised values. */
function rand(len = 8) {
    return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

class UserBlockService {
    /**
     * Block a user — sets status = false so all apps reject their next login.
     * Safe to call if already blocked.
     */
    async blockUser(userId, userType, reason = null) {
        const where = whereForType(userId, userType);
        const user = await users.findOne({ where });
        if (!user) throw new NotFoundError('User not found');

        await users.update({ status: false }, { where: { id: user.id } });
        return {
            userId: user.id,
            blocked: true,
            reason,
            message: 'User blocked successfully. They will not be able to log in.',
        };
    }

    /**
     * Unblock a user — restores status = true.
     */
    async unblockUser(userId, userType) {
        const where = whereForType(userId, userType);
        const user = await users.findOne({ where });
        if (!user) throw new NotFoundError('User not found');

        await users.update({ status: true }, { where: { id: user.id } });
        return {
            userId: user.id,
            blocked: false,
            message: 'User unblocked successfully.',
        };
    }

    /**
     * Anonymize + soft-delete a user.
     * - PII (name, email, phone) is scrambled.
     * - Booking history foreign keys remain intact.
     * - status set to false so login is impossible even if paranoid un-deletes.
     * - Sequelize paranoid deletedAt is set via destroy().
     *
     * Refuses if the user has active (non-terminal) bookings.
     */
    async anonymizeAndDelete(userId, userType) {
        const where = whereForType(userId, userType);
        const user = await users.findOne({ where });
        if (!user) throw new NotFoundError('User not found');

        // Guard: do not anonymise if there are open bookings
        const TERMINAL_STATUSES = [17, 19, 23];
        const activeCount = await booking.count({
            where: {
                [Op.or]: [
                    { customerId: user.id },
                    { driverId: user.id },
                    { deliveryDriverId: user.id },
                ],
                bookingStatusId: { [Op.notIn]: TERMINAL_STATUSES },
            },
        });
        if (activeCount > 0) {
            throw new UnprocessableEntityError(
                `User has ${activeCount} active booking(s). Complete or cancel them before deleting.`
            );
        }

        const tag = rand(10);
        await users.update(
            {
                firstName: 'Deleted',
                lastName: 'User',
                email: `deleted_${tag}@anonymized.local`,
                phoneNum: null,
                password: null,
                dvToken: null,
                image: null,
                status: false,
            },
            { where: { id: user.id } }
        );

        // Paranoid soft-delete (sets deletedAt)
        await users.destroy({ where: { id: user.id } });

        return { userId: user.id, anonymized: true, message: 'User data anonymized and account deleted.' };
    }

    /**
     * Get block status for a user.
     */
    async getBlockStatus(userId) {
        const user = await users.findOne({
            where: { id: Number(userId) },
            attributes: ['id', 'status', 'firstName', 'lastName', 'email'],
        });
        if (!user) throw new NotFoundError('User not found');
        return { userId: user.id, blocked: !user.status };
    }
}

module.exports = new UserBlockService();

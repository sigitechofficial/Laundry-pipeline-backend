'use strict';
/**
 * Admin block/unblock + anonymize-on-delete for any user type.
 *
 * Block: users.status = false, Redis sessions revoked, recurring plans paused.
 * Logged-in apps are refused on the next API call (JWT middleware checks status).
 * Refuses if the user still has incomplete orders.
 */
const crypto = require('crypto');
const { users, booking, addressDb, recurringPlan } = require('../../models');
const { Op } = require('sequelize');
const redisCli = require('../../redis/redis');
const {
    NotFoundError,
    UnprocessableEntityError,
} = require('../../middlewares/universalErrorHandler');
const { CLASSIFIED_AS, SYSTEM_ROLES } = require('../../constants/systemRoles');
const {
    SHOP_ADDRESS_TYPE,
    openCustomerBookingWhere,
    openAssignedBookingWhere,
    openAgentOwnerBookingWhere,
} = require('../../utils/openBookingGuard');

const BLOCK_USER_TYPES = Object.freeze({
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
        case BLOCK_USER_TYPES.customer:
            return { id, userTypeId: 2 };
        case BLOCK_USER_TYPES.driver:
            return { id, roleId: SYSTEM_ROLES.LAUNDRY_SHOP_DRIVER, classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE };
        case BLOCK_USER_TYPES.agent:
            return { id, userTypeId: 3 };
        case BLOCK_USER_TYPES.agent_employee:
            return { id, classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE };
        case BLOCK_USER_TYPES.admin_employee:
            return { id, classifiedAsId: CLASSIFIED_AS.ADMIN_EMPLOYEE };
        default:
            return { id };
    }
}

function rand(len = 8) {
    return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

async function countOpenBookingsForBlock(user, userType) {
    if (userType === BLOCK_USER_TYPES.customer) {
        return booking.count({
            where: openCustomerBookingWhere(user.id, Op),
        });
    }

    if (userType === BLOCK_USER_TYPES.agent) {
        const shop = await addressDb.findOne({
            where: { userId: user.id, addressType: SHOP_ADDRESS_TYPE },
            attributes: ['id'],
        });
        return booking.count({
            where: openAgentOwnerBookingWhere(user.id, shop?.id, Op),
        });
    }

    if (
        userType === BLOCK_USER_TYPES.driver ||
        userType === BLOCK_USER_TYPES.agent_employee
    ) {
        return booking.count({
            where: openAssignedBookingWhere(user.id, Op),
        });
    }

    return 0;
}

async function revokeAppSessions(userId) {
    try {
        await redisCli.del(`id-${userId}`);
    } catch (err) {
        console.warn(`[block] Redis session revoke failed for user ${userId}:`, err.message);
    }
}

async function pauseCustomerRecurringPlans(customerId) {
    const [pausedCount] = await recurringPlan.update(
        {
            status: 'paused',
            notes: 'Paused because the customer was blocked by admin.',
        },
        {
            where: {
                customerId: Number(customerId),
                status: 'active',
            },
        }
    );
    return pausedCount;
}

class UserBlockService {
    /**
     * Block a user. Refuses while they have incomplete orders.
     * Recurring frequency plans are paused so no further orders are auto-created.
     */
    async blockUser(userId, userType, reason = null) {
        const where = whereForType(userId, userType);
        const user = await users.findOne({ where });
        if (!user) throw new NotFoundError('User not found');

        let recurringPaused = 0;
        if (userType === BLOCK_USER_TYPES.customer) {
            recurringPaused = await pauseCustomerRecurringPlans(user.id);
        }

        const activeCount = await countOpenBookingsForBlock(user, userType);
        if (activeCount > 0) {
            throw new UnprocessableEntityError(
                `This account has ${activeCount} incomplete order(s). Complete or cancel them before blocking.` +
                    (recurringPaused
                        ? ` Recurring frequency was paused so no further orders will be auto-created.`
                        : '')
            );
        }

        await users.update({ status: false }, { where: { id: user.id } });
        await revokeAppSessions(user.id);

        return {
            userId: user.id,
            blocked: true,
            reason,
            recurringPaused,
            message:
                'User blocked. They cannot continue in the app until unblocked. Contact support is shown on their next request.',
        };
    }

    async unblockUser(userId, userType) {
        const where = whereForType(userId, userType);
        const user = await users.findOne({ where });
        if (!user) throw new NotFoundError('User not found');

        await users.update({ status: true }, { where: { id: user.id } });
        return {
            userId: user.id,
            blocked: false,
            message: 'User unblocked successfully. Recurring plans stay paused until they place a new order or support re-enables them.',
        };
    }

    async anonymizeAndDelete(userId, userType) {
        const where = whereForType(userId, userType);
        const user = await users.findOne({ where });
        if (!user) throw new NotFoundError('User not found');

        const activeCount = await countOpenBookingsForBlock(user, userType);
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

        await users.destroy({ where: { id: user.id } });
        await revokeAppSessions(user.id);

        return { userId: user.id, anonymized: true, message: 'User data anonymized and account deleted.' };
    }

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
module.exports.USER_TYPES = BLOCK_USER_TYPES;

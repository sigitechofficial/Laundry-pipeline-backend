const { Op } = require('sequelize');
const {
    bookingAssignmentEvent,
    booking,
    users,
    addressDb,
} = require('../../models');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');

/**
 * Aggregate staff activity for a shop (assignment events + completed jobs).
 */
class StaffActivityService {
    async _shopAddressId(shopAgentId) {
        const shopAddress = await addressDb.findOne({
            where: {
                userId: shopAgentId,
                addressType: 'LaundaryShopAddress',
            },
            attributes: ['id'],
        });
        if (!shopAddress) {
            throw new NotFoundError('Agent shop address not found');
        }
        return shopAddress.id;
    }

    /**
     * @param {number} shopAgentId
     * @param {{ from?: string, to?: string, employeeId?: number|string, type?: string }} [query]
     */
    async getStaffActivity(shopAgentId, query = {}) {
        const shopAddressId = await this._shopAddressId(shopAgentId);
        const now = new Date();
        const from = query.from
            ? new Date(query.from)
            : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const to = query.to ? new Date(query.to) : now;
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
            throw new ValidationError('Invalid from/to date');
        }

        const employeeId =
            query.employeeId != null && query.employeeId !== ''
                ? Number(query.employeeId)
                : null;
        const typeFilter = query.type
            ? String(query.type).toLowerCase()
            : null;

        const shopBookings = await booking.findAll({
            where: { laundryShopId: shopAddressId },
            attributes: ['id'],
            raw: true,
        });
        const bookingIds = shopBookings.map((b) => b.id);
        if (!bookingIds.length) {
            return { drivers: [], from, to };
        }

        const eventWhere = {
            bookingId: { [Op.in]: bookingIds },
            createdAt: { [Op.between]: [from, to] },
        };
        if (employeeId) {
            eventWhere[Op.or] = [
                { toUserId: employeeId },
                { fromUserId: employeeId },
            ];
        }
        if (typeFilter === 'pickup' || typeFilter === 'delivery') {
            eventWhere.assignmentType = typeFilter;
        }

        const events = await bookingAssignmentEvent.findAll({
            where: eventWhere,
            order: [['createdAt', 'DESC']],
            limit: 500,
            include: [
                {
                    model: users,
                    as: 'toUser',
                    attributes: ['id', 'firstName', 'lastName'],
                    required: false,
                },
                {
                    model: users,
                    as: 'fromUser',
                    attributes: ['id', 'firstName', 'lastName'],
                    required: false,
                },
            ],
        });

        // Completed bookings (status 16) in range where driver fields set
        const completedWhere = {
            laundryShopId: shopAddressId,
            bookingStatusId: 16,
            updatedAt: { [Op.between]: [from, to] },
        };
        if (employeeId) {
            completedWhere[Op.or] = [
                { driverId: employeeId },
                { deliveryDriverId: employeeId },
            ];
        }

        const completed = await booking.findAll({
            where: completedWhere,
            attributes: [
                'id',
                'orderTrackId',
                'driverId',
                'deliveryDriverId',
                'bookingStatusId',
                'updatedAt',
            ],
            limit: 500,
        });

        const driverMap = new Map();

        const ensureDriver = (id, nameBits = {}) => {
            const key = Number(id);
            if (!key || Number.isNaN(key)) return null;
            if (!driverMap.has(key)) {
                driverMap.set(key, {
                    id: key,
                    name:
                        [nameBits.firstName, nameBits.lastName]
                            .filter(Boolean)
                            .join(' ')
                            .trim() || `User ${key}`,
                    pickups: 0,
                    deliveries: 0,
                    jobs: [],
                });
            }
            return driverMap.get(key);
        };

        for (const ev of events) {
            const plain = ev.get({ plain: true });
            const isUnassign =
                plain.action === 'unassign' || plain.source === 'self_return';
            const subjectId = isUnassign ? plain.fromUserId : plain.toUserId;
            if (!subjectId) continue;
            if (Number(subjectId) === Number(shopAgentId)) continue;
            if (employeeId && Number(subjectId) !== Number(employeeId)) continue;

            const nameBits = isUnassign
                ? plain.fromUser || {}
                : plain.toUser || {};
            const entry = ensureDriver(subjectId, nameBits);
            if (!entry) continue;
            if (!isUnassign) {
                if (plain.assignmentType === 'pickup') entry.pickups += 1;
                if (plain.assignmentType === 'delivery') entry.deliveries += 1;
            }
            entry.jobs.push({
                source: 'assignmentEvent',
                bookingId: plain.bookingId,
                assignmentType: plain.assignmentType,
                action: plain.action,
                eventSource: plain.source,
                at: plain.createdAt,
            });
        }

        for (const row of completed) {
            const plain = row.get({ plain: true });
            const pickupId = plain.driverId != null ? Number(plain.driverId) : null;
            const deliveryId =
                plain.deliveryDriverId != null
                    ? Number(plain.deliveryDriverId)
                    : null;

            if (
                pickupId &&
                pickupId !== Number(shopAgentId) &&
                (!employeeId || pickupId === employeeId) &&
                (!typeFilter || typeFilter === 'pickup')
            ) {
                const entry = ensureDriver(pickupId);
                if (entry) {
                    entry.pickups += 1;
                    entry.jobs.push({
                        source: 'completedBooking',
                        bookingId: plain.id,
                        orderTrackId: plain.orderTrackId,
                        assignmentType: 'pickup',
                        at: plain.updatedAt,
                    });
                }
            }

            if (
                deliveryId &&
                deliveryId !== Number(shopAgentId) &&
                (!employeeId || deliveryId === employeeId) &&
                (!typeFilter || typeFilter === 'delivery')
            ) {
                const entry = ensureDriver(deliveryId);
                if (entry) {
                    entry.deliveries += 1;
                    entry.jobs.push({
                        source: 'completedBooking',
                        bookingId: plain.id,
                        orderTrackId: plain.orderTrackId,
                        assignmentType: 'delivery',
                        at: plain.updatedAt,
                    });
                }
            }
        }

        // Fill missing names
        const missingIds = [...driverMap.values()]
            .filter((d) => d.name.startsWith('User '))
            .map((d) => d.id);
        if (missingIds.length) {
            const nameRows = await users.findAll({
                where: { id: { [Op.in]: missingIds } },
                attributes: ['id', 'firstName', 'lastName'],
                raw: true,
            });
            for (const u of nameRows) {
                const entry = driverMap.get(Number(u.id));
                if (entry) {
                    entry.name =
                        [u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
                        entry.name;
                }
            }
        }

        return {
            drivers: [...driverMap.values()].sort((a, b) =>
                a.name.localeCompare(b.name)
            ),
            from,
            to,
        };
    }
}

module.exports = new StaffActivityService();

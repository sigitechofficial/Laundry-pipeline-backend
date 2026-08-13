const { Op } = require('sequelize');
const {
    bookingAssignmentEvent,
    booking,
    users,
    addressDb,
} = require('../../models');
const { ValidationError, NotFoundError } = require('../../middlewares/universalErrorHandler');

/**
 * Aggregate staff activity for a shop (assignment events + completed legs).
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
     * @param {{ from?: string, to?: string, employeeId?: number|string, type?: string, includeActive?: boolean|string }} [query]
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
        const includeActive =
            query.includeActive === true ||
            query.includeActive === '1' ||
            query.includeActive === 'true';

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
                { actedByUserId: employeeId },
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

        // Completed bookings: status 17 (and legacy 16) with completion snapshots
        // or live assignee as fallback for older rows.
        const completedWhere = {
            laundryShopId: shopAddressId,
            bookingStatusId: { [Op.in]: [16, 17] },
            [Op.or]: [
                { pickupCompletedAt: { [Op.between]: [from, to] } },
                { deliveryCompletedAt: { [Op.between]: [from, to] } },
                {
                    pickupCompletedAt: null,
                    deliveryCompletedAt: null,
                    updatedAt: { [Op.between]: [from, to] },
                },
            ],
        };
        if (employeeId) {
            completedWhere[Op.and] = [
                {
                    [Op.or]: [
                        { pickupCompletedByUserId: employeeId },
                        { deliveryCompletedByUserId: employeeId },
                        { driverId: employeeId },
                        { deliveryDriverId: employeeId },
                    ],
                },
            ];
        }

        const completed = await booking.findAll({
            where: completedWhere,
            attributes: [
                'id',
                'orderTrackId',
                'driverId',
                'deliveryDriverId',
                'pickupCompletedByUserId',
                'pickupCompletedAt',
                'deliveryCompletedByUserId',
                'deliveryCompletedAt',
                'bookingStatusId',
                'updatedAt',
            ],
            limit: 500,
        });

        // Active jobs currently assigned to this employee (My Jobs History).
        let activeRows = [];
        if (includeActive && employeeId) {
            const activeOr = [];
            if (!typeFilter || typeFilter === 'pickup') {
                activeOr.push({ driverId: employeeId });
            }
            if (!typeFilter || typeFilter === 'delivery') {
                activeOr.push({ deliveryDriverId: employeeId });
            }
            if (activeOr.length) {
                activeRows = await booking.findAll({
                    where: {
                        laundryShopId: shopAddressId,
                        bookingStatusId: { [Op.notIn]: [16, 17, 18, 19] },
                        [Op.or]: activeOr,
                    },
                    attributes: [
                        'id',
                        'orderTrackId',
                        'driverId',
                        'deliveryDriverId',
                        'bookingStatusId',
                        'collectionDate',
                        'deliveryDate',
                        'updatedAt',
                    ],
                    limit: 200,
                });
            }
        }

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
                    completedPickups: 0,
                    completedDeliveries: 0,
                    jobs: [],
                });
            }
            return driverMap.get(key);
        };

        for (const ev of events) {
            const plain = ev.get({ plain: true });
            const isComplete = plain.action === 'complete';
            const isUnassign =
                plain.action === 'unassign' || plain.source === 'self_return';
            const subjectId = isComplete
                ? plain.toUserId || plain.actedByUserId
                : isUnassign
                  ? plain.fromUserId
                  : plain.toUserId;
            if (!subjectId) continue;
            if (Number(subjectId) === Number(shopAgentId)) continue;
            if (employeeId && Number(subjectId) !== Number(employeeId)) continue;

            const nameBits = isUnassign
                ? plain.fromUser || {}
                : plain.toUser || {};
            const entry = ensureDriver(subjectId, nameBits);
            if (!entry) continue;

            if (isComplete) {
                if (plain.assignmentType === 'pickup') {
                    entry.completedPickups += 1;
                    entry.pickups += 1;
                }
                if (plain.assignmentType === 'delivery') {
                    entry.completedDeliveries += 1;
                    entry.deliveries += 1;
                }
            } else if (!isUnassign) {
                if (plain.assignmentType === 'pickup') entry.pickups += 1;
                if (plain.assignmentType === 'delivery') entry.deliveries += 1;
            }

            entry.jobs.push({
                source: isComplete ? 'completedLeg' : 'assignmentEvent',
                bookingId: plain.bookingId,
                assignmentType: plain.assignmentType,
                action: plain.action,
                eventSource: plain.source,
                at: plain.createdAt,
            });
        }

        for (const row of completed) {
            const plain = row.get({ plain: true });
            const pickupDoneBy =
                plain.pickupCompletedByUserId != null
                    ? Number(plain.pickupCompletedByUserId)
                    : plain.driverId != null
                      ? Number(plain.driverId)
                      : null;
            const deliveryDoneBy =
                plain.deliveryCompletedByUserId != null
                    ? Number(plain.deliveryCompletedByUserId)
                    : plain.deliveryDriverId != null
                      ? Number(plain.deliveryDriverId)
                      : null;

            const alreadyHasComplete = (driverEntry, type) =>
                driverEntry.jobs.some(
                    (j) =>
                        (j.source === 'completedLeg' ||
                            j.source === 'completedBooking') &&
                        Number(j.bookingId) === Number(plain.id) &&
                        j.assignmentType === type
                );

            if (
                pickupDoneBy &&
                pickupDoneBy !== Number(shopAgentId) &&
                (!employeeId || pickupDoneBy === employeeId) &&
                (!typeFilter || typeFilter === 'pickup')
            ) {
                const entry = ensureDriver(pickupDoneBy);
                if (entry && !alreadyHasComplete(entry, 'pickup')) {
                    entry.completedPickups += 1;
                    entry.pickups += 1;
                    entry.jobs.push({
                        source: 'completedBooking',
                        bookingId: plain.id,
                        orderTrackId: plain.orderTrackId,
                        assignmentType: 'pickup',
                        action: 'complete',
                        at: plain.pickupCompletedAt || plain.updatedAt,
                    });
                }
            }

            if (
                deliveryDoneBy &&
                deliveryDoneBy !== Number(shopAgentId) &&
                (!employeeId || deliveryDoneBy === employeeId) &&
                (!typeFilter || typeFilter === 'delivery')
            ) {
                const entry = ensureDriver(deliveryDoneBy);
                if (entry && !alreadyHasComplete(entry, 'delivery')) {
                    entry.completedDeliveries += 1;
                    entry.deliveries += 1;
                    entry.jobs.push({
                        source: 'completedBooking',
                        bookingId: plain.id,
                        orderTrackId: plain.orderTrackId,
                        assignmentType: 'delivery',
                        action: 'complete',
                        at: plain.deliveryCompletedAt || plain.updatedAt,
                    });
                }
            }
        }

        for (const row of activeRows) {
            const plain = row.get({ plain: true });
            const pickupId =
                plain.driverId != null ? Number(plain.driverId) : null;
            const deliveryId =
                plain.deliveryDriverId != null
                    ? Number(plain.deliveryDriverId)
                    : null;
            const entry = ensureDriver(employeeId);
            if (!entry) continue;

            const hasJob = (type) =>
                entry.jobs.some(
                    (j) =>
                        Number(j.bookingId) === Number(plain.id) &&
                        j.assignmentType === type
                );

            if (
                pickupId === Number(employeeId) &&
                (!typeFilter || typeFilter === 'pickup') &&
                !hasJob('pickup')
            ) {
                entry.pickups += 1;
                entry.jobs.push({
                    source: 'activeAssignment',
                    bookingId: plain.id,
                    orderTrackId: plain.orderTrackId,
                    assignmentType: 'pickup',
                    action: 'assigned',
                    bookingStatusId: plain.bookingStatusId,
                    at: plain.collectionDate || plain.updatedAt,
                });
            }
            if (
                deliveryId === Number(employeeId) &&
                (!typeFilter || typeFilter === 'delivery') &&
                !hasJob('delivery')
            ) {
                entry.deliveries += 1;
                entry.jobs.push({
                    source: 'activeAssignment',
                    bookingId: plain.id,
                    orderTrackId: plain.orderTrackId,
                    assignmentType: 'delivery',
                    action: 'assigned',
                    bookingStatusId: plain.bookingStatusId,
                    at: plain.deliveryDate || plain.updatedAt,
                });
            }
        }

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

        for (const entry of driverMap.values()) {
            entry.jobs.sort(
                (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
            );
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

require("dotenv").config();
const {
    users,
    bussinessInformation,
    driverInZones,
    addressDb,
    booking,
    bookingHistory,
    bookingStatus,
    staffUnassignReason,
} = require('../../models');
const { Op } = require('sequelize');
const {
    NotFoundError,
    ValidationError,
} = require('../../middlewares/universalErrorHandler');
const momentTz = require('moment-timezone');
const assignmentAuditService = require('./assignmentAuditService');
const liveTrackingRtdb = require('../../utils/liveTrackingRtdb');
const {
    notifyStaffAssignmentChange,
} = require('../../utils/staffAssignmentNotify');

/** Delivered / Completed / Cancelled / Refunded — no staff unassign. */
const TERMINAL_UNASSIGN_STATUSES = new Set([16, 17, 19, 21]);

const AGENT_BUSINESS_TIME_ZONE = "Europe/London";
const LAUNDRY_SHOP_DRIVER_ROLE_ID = 6;
const LAUNDRY_SHOP_MANAGER_ROLE_ID = 8;
const ASSIGNABLE_STAFF_ROLE_IDS = [
    LAUNDRY_SHOP_DRIVER_ROLE_ID,
    LAUNDRY_SHOP_MANAGER_ROLE_ID,
];

/**
 * Agent Driver / Staff Assignment Service
 * Shop owner assigns, unassigns, and reassigns pickup/delivery staff on bookings.
 */
class AgentDriverManagementService {
    _getWallClockDateTime(timeZone) {
        const normalizedTimeZone =
            timeZone && typeof timeZone === 'string' && momentTz.tz.zone(timeZone.trim())
                ? timeZone.trim()
                : AGENT_BUSINESS_TIME_ZONE;
        const wallClock = momentTz.tz(normalizedTimeZone);
        return {
            date: wallClock.format('YYYY-MM-DD'),
            time: wallClock.format('HH:mm:ss'),
        };
    }

    async _getShopContext(agentId) {
        const shopAddress = await addressDb.findOne({
            where: {
                userId: agentId,
                addressType: 'LaundaryShopAddress',
            },
            attributes: ['id', 'zoneId', 'userId'],
        });
        if (!shopAddress) {
            throw new NotFoundError('Agent shop address not found');
        }

        const business = await bussinessInformation.findOne({
            where: { agentId },
            attributes: ['id', 'shopAddressId', 'agentId'],
        });

        return { shopAddress, business };
    }

    async _assertBookingOwnedByShop(bookingId, shopAddressId) {
        const row = await booking.findByPk(bookingId);
        if (!row) {
            throw new NotFoundError('Booking not found');
        }
        if (Number(row.laundryShopId) !== Number(shopAddressId)) {
            throw new ValidationError('This booking does not belong to your shop');
        }
        return row;
    }

    async _assertAssignableStaff(agentId, staffId) {
        const staffIdNum = Number(staffId);
        if (!staffIdNum) {
            throw new ValidationError('staffId / driverId is required');
        }

        // Owner may assign themselves
        if (staffIdNum === Number(agentId)) {
            return { id: staffIdNum, isOwner: true };
        }

        const staff = await users.findOne({
            where: {
                id: staffIdNum,
                employeeOff: agentId,
                classifiedAsId: 1,
                status: true,
            },
            attributes: ['id', 'firstName', 'lastName', 'email', 'roleId', 'image', 'status'],
        });

        if (!staff) {
            throw new ValidationError(
                'Selected staff is not an active employee of this shop'
            );
        }

        return { ...staff.get({ plain: true }), isOwner: false };
    }

    _assignmentField(assignmentType) {
        const type = String(assignmentType || 'pickup').toLowerCase();
        if (type === 'delivery') {
            return { field: 'deliveryDriverId', label: 'delivery' };
        }
        return { field: 'driverId', label: 'pickup' };
    }

    async _writeAssignmentHistory(bookingId, statusId, timeZone, clientTimeZone) {
        const { date, time } = this._getWallClockDateTime(timeZone || clientTimeZone);
        await bookingHistory.create({
            date,
            time,
            bookingId,
            bookingStatusId: statusId,
        });
    }

    /**
     * Mid-trip assign/unassign: keep RTDB publisher on the current assignee.
     * No-ops when there is no active session (status 3, closed, etc.).
     */
    async _syncLiveTrackingAssignee(bookingId, newUserId) {
        try {
            await liveTrackingRtdb.reassignLiveTrackingAgent(
                bookingId,
                Number(newUserId)
            );
        } catch (err) {
            console.warn(
                '[assign] live tracking reassign failed:',
                err?.message || err
            );
        }
    }

    /**
     * List laundry-shop drivers for this agent (fixes hardcoded laundaryShopId: 1).
     */
    async agnetDrivers(agentId) {
        const { business } = await this._getShopContext(agentId);

        const whereZone = business?.id
            ? { laundaryShopId: business.id }
            : {};

        let driverFound = [];
        if (business?.id) {
            driverFound = await driverInZones.findAll({
                where: whereZone,
                include: [
                    {
                        model: users,
                        as: 'driverInZone',
                        where: {
                            classifiedAsId: 1,
                            employeeOff: agentId,
                            roleId: { [Op.in]: ASSIGNABLE_STAFF_ROLE_IDS },
                            status: true,
                        },
                        attributes: ['id', 'firstName', 'lastName', 'email', 'image', 'phoneNum', 'status'],
                        required: true,
                    },
                ],
                attributes: ['id', 'status', 'cityId', 'countryId', 'zoneId', 'laundaryShopId'],
            });
        }

        // Fallback: employees with driver role even if driverInZones row is missing/mislinked
        const drivers = await users.findAll({
            where: {
                employeeOff: agentId,
                classifiedAsId: 1,
                roleId: { [Op.in]: ASSIGNABLE_STAFF_ROLE_IDS },
                status: true,
            },
            attributes: ['id', 'firstName', 'lastName', 'email', 'image', 'phoneNum', 'status', 'roleId'],
        });

        return {
            driverFound,
            drivers,
        };
    }

    /**
     * assignmentType maps to booking fields:
     * - pickup → driverId only
     * - delivery → deliveryDriverId only
     * - both → both legs (same staff)
     * Opt-in: alsoAssignDelivery=true with pickup also assigns delivery.
     */
    _legsToAssign(assignmentType, { alsoAssignDelivery } = {}) {
        const type = String(assignmentType || 'pickup').toLowerCase();
        if (type === 'delivery') return ['delivery'];
        if (type === 'both') return ['pickup', 'delivery'];
        if (type === 'pickup' && alsoAssignDelivery === true) {
            return ['pickup', 'delivery'];
        }
        return ['pickup'];
    }

    async listStaffUnassignReasons() {
        const rows = await staffUnassignReason.findAll({
            where: { status: true },
            attributes: ['id', 'label', 'sortOrder', 'isOther'],
            order: [
                ['sortOrder', 'ASC'],
                ['id', 'ASC'],
            ],
        });
        return {
            reasons: rows.map((r) => r.get({ plain: true })),
        };
    }

    async _resolveUnassignReason(data) {
        const reasonId = data.reasonId != null ? Number(data.reasonId) : null;
        const note =
            data.note != null && String(data.note).trim() !== ''
                ? String(data.note).trim()
                : null;

        if (!reasonId || Number.isNaN(reasonId)) {
            throw new ValidationError(
                'Please select a reason for unassigning this job'
            );
        }

        const reason = await staffUnassignReason.findOne({
            where: { id: reasonId, status: true },
            attributes: ['id', 'label', 'isOther'],
        });
        if (!reason) {
            throw new ValidationError('Invalid unassign reason');
        }

        if (reason.isOther && (!note || note.length < 3)) {
            throw new ValidationError(
                'Please add a short note when selecting Other'
            );
        }

        return {
            reasonId: reason.id,
            reasonText: reason.label,
            note,
        };
    }

    async _assignSingleLeg({
        bookingId,
        bookingRow,
        staff,
        assignmentType,
        agentId,
        actedBy,
        timeZone,
        clientTimeZone,
    }) {
        const { field, label } = this._assignmentField(assignmentType);
        const fromUserId =
            bookingRow[field] != null ? Number(bookingRow[field]) : null;
        const hadPriorAssignee =
            fromUserId != null && fromUserId !== Number(staff.id);
        const action = hadPriorAssignee ? 'reassign' : 'assign';

        await booking.update({ [field]: staff.id }, { where: { id: bookingId } });
        // Keep in-memory row in sync for multi-leg assigns
        bookingRow[field] = staff.id;

        await this._writeAssignmentHistory(
            bookingId,
            bookingRow.bookingStatusId,
            timeZone,
            clientTimeZone
        );

        await assignmentAuditService.recordEvent({
            bookingId,
            assignmentType: label,
            action,
            fromUserId,
            toUserId: staff.id,
            actedByUserId: actedBy,
            source: 'manual',
        });

        notifyStaffAssignmentChange({
            bookingId,
            orderTrackId: bookingRow.orderTrackId,
            assignmentType: label,
            action,
            toUserId: staff.id,
            fromUserId,
            shopOwnerUserId: agentId,
        }).catch(() => {});

        return { label, action, fromUserId };
    }

    /**
     * Assign pickup or delivery staff. Does NOT jump booking to Out for Delivery.
     * Body: { bookingId, driverId|staffId, assignmentType?: 'pickup'|'delivery'|'both', alsoAssignDelivery?: boolean }
     * Pickup and delivery are independent unless type=both or alsoAssignDelivery=true.
     * @param {number|null} [actorUserId] - user who performed the action (defaults to agentId)
     */
    async assignBookingStaff(data, agentId, actorUserId = null) {
        const {
            bookingId,
            driverId,
            staffId,
            assignmentType = 'pickup',
            timeZone,
            clientTimeZone,
            alsoAssignDelivery,
        } = data;

        if (!bookingId) {
            throw new ValidationError('bookingId is required');
        }

        const targetStaffId = staffId ?? driverId;
        const { shopAddress } = await this._getShopContext(agentId);
        const bookingRow = await this._assertBookingOwnedByShop(bookingId, shopAddress.id);
        const staff = await this._assertAssignableStaff(agentId, targetStaffId);
        const actedBy = actorUserId != null ? Number(actorUserId) : Number(agentId);

        const legs = this._legsToAssign(assignmentType, { alsoAssignDelivery });

        const results = [];
        for (const leg of legs) {
            results.push(
                await this._assignSingleLeg({
                    bookingId,
                    bookingRow,
                    staff,
                    assignmentType: leg,
                    agentId,
                    actedBy,
                    timeZone,
                    clientTimeZone,
                })
            );
        }

        // Live tracking follows the assignee of the leg(s) we just set.
        await this._syncLiveTrackingAssignee(bookingId, staff.id);

        const labels = results.map((r) => r.label);
        const message =
            labels.length > 1
                ? `Pickup and delivery assigned to the same staff`
                : `${labels[0]} staff assigned successfully`;

        return {
            message,
            bookingId: Number(bookingId),
            assignmentType: labels.length > 1 ? 'both' : labels[0],
            assignedLegs: labels,
            assignedTo: {
                id: staff.id,
                firstName: staff.firstName || null,
                lastName: staff.lastName || null,
                isOwner: !!staff.isOwner,
            },
        };
    }

    /**
     * Backward-compatible wrapper — assigns pickup staff without forcing Out for Delivery.
     */
    async agentAssignBookingToLaundryDriver(data, agentId, actorUserId = null) {
        return this.assignBookingStaff(
            { ...data, assignmentType: 'pickup' },
            agentId,
            actorUserId
        );
    }

    /**
     * Unassign staff: return pickup/delivery field to shop owner (shop-held).
     * Requires reasonId (+ note when reason is Other).
     * When opts.selfOnly is true, only the current assignee may return that leg.
     */
    async unassignBookingStaff(data, agentId, actorUserId = null, opts = {}) {
        const {
            bookingId,
            assignmentType = 'pickup',
            timeZone,
            clientTimeZone,
        } = data;
        if (!bookingId) {
            throw new ValidationError('bookingId is required');
        }

        const reasonMeta = await this._resolveUnassignReason(data);

        const { shopAddress } = await this._getShopContext(agentId);
        const bookingRow = await this._assertBookingOwnedByShop(bookingId, shopAddress.id);
        const { field, label } = this._assignmentField(assignmentType);
        const fromUserId =
            bookingRow[field] != null ? Number(bookingRow[field]) : null;
        const actedBy = actorUserId != null ? Number(actorUserId) : Number(agentId);
        const statusId = Number(bookingRow.bookingStatusId);

        if (TERMINAL_UNASSIGN_STATUSES.has(statusId)) {
            throw new ValidationError(
                'Cannot unassign a delivered, completed, cancelled, or refunded booking'
            );
        }

        if (opts.selfOnly === true) {
            if (fromUserId == null || fromUserId !== actedBy) {
                throw new ValidationError(
                    'You can only return a job that is assigned to you'
                );
            }
            // Shop-held already — nothing to do
            if (fromUserId === Number(agentId)) {
                return {
                    message: `${label} is already with the shop owner`,
                    bookingId: Number(bookingId),
                    assignmentType: label,
                    assignedTo: { id: agentId, isOwner: true },
                };
            }
        }

        // Keep jobs shop-owned (same pattern as accept/admin assign)
        await booking.update(
            { [field]: agentId },
            { where: { id: bookingId } }
        );

        await this._writeAssignmentHistory(
            bookingId,
            bookingRow.bookingStatusId,
            timeZone,
            clientTimeZone
        );

        const auditSource = opts.selfOnly === true ? 'self_return' : 'manual';
        await assignmentAuditService.recordEvent({
            bookingId,
            assignmentType: label,
            action: 'unassign',
            fromUserId,
            toUserId: Number(agentId),
            actedByUserId: actedBy,
            source: auditSource,
            reasonId: reasonMeta.reasonId,
            reasonText: reasonMeta.reasonText,
            note: reasonMeta.note,
        });

        await this._syncLiveTrackingAssignee(bookingId, agentId);

        notifyStaffAssignmentChange({
            bookingId,
            orderTrackId: bookingRow.orderTrackId,
            assignmentType: label,
            action: auditSource === 'self_return' ? 'self_return' : 'unassign',
            toUserId: Number(agentId),
            fromUserId,
            shopOwnerUserId: agentId,
        }).catch(() => {});

        return {
            message:
                opts.selfOnly === true
                    ? `${label} returned to shop owner — you are no longer assigned`
                    : `${label} staff unassigned; job returned to shop owner`,
            bookingId: Number(bookingId),
            assignmentType: label,
            assignedTo: { id: agentId, isOwner: true },
            reason: {
                id: reasonMeta.reasonId,
                label: reasonMeta.reasonText,
                note: reasonMeta.note,
            },
        };
    }

    /**
     * Reassign to another staff member (atomic field swap).
     */
    async reassignBookingStaff(data, agentId, actorUserId = null) {
        return this.assignBookingStaff(data, agentId, actorUserId);
    }

    /**
     * Owner takes the job themselves for the requested leg (pickup or delivery).
     */
    async agentPickupOrderBySelf(data, agentId, actorUserId = null) {
        const {
            bookingId,
            staffId,
            assignmentType = 'pickup',
            timeZone,
            clientTimeZone,
            alsoAssignDelivery,
        } = data;
        return this.assignBookingStaff(
            {
                bookingId,
                staffId: staffId != null ? staffId : agentId,
                assignmentType,
                timeZone,
                clientTimeZone,
                alsoAssignDelivery,
            },
            agentId,
            actorUserId
        );
    }

    /**
     * Monitor board: jobs for this shop, optionally filtered by employee.
     * Query: employeeId?, assignmentType?, statusGroup?
     */
    async getStaffJobs(agentId, query = {}) {
        const { shopAddress } = await this._getShopContext(agentId);
        const {
            employeeId,
            assignmentType = 'pickup',
            statusGroup, // unassigned | assigned | active | all
        } = query;

        const { field } = this._assignmentField(assignmentType);

        const where = {
            laundryShopId: shopAddress.id,
            bookingStatusId: { [Op.notIn]: [16, 17, 18, 19] }, // delivered/completed / cancelled / refunded
        };

        if (employeeId) {
            where[field] = Number(employeeId);
        } else if (statusGroup === 'unassigned') {
            where[field] = agentId;
        } else if (statusGroup === 'assigned') {
            where[field] = { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: agentId }] };
        }

        const rows = await booking.findAll({
            where,
            attributes: [
                'id',
                'orderTrackId',
                'bookingStatusId',
                'driverId',
                'deliveryDriverId',
                'collectionDate',
                'deliveryDate',
                'laundryShopId',
            ],
            include: [
                {
                    model: bookingStatus,
                    attributes: ['id', 'title', 'description'],
                    required: false,
                },
                {
                    model: users,
                    as: 'customer',
                    attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum'],
                    required: false,
                },
                {
                    model: users,
                    as: 'driver',
                    attributes: ['id', 'firstName', 'lastName', 'image'],
                    required: false,
                },
                {
                    model: users,
                    as: 'deliveryDriver',
                    attributes: ['id', 'firstName', 'lastName', 'image'],
                    required: false,
                },
            ],
            order: [['id', 'DESC']],
            limit: 100,
        });

        const jobs = rows.map((row) => {
            const plain = row.get({ plain: true });
            const pickupId = plain.driverId != null ? Number(plain.driverId) : null;
            const deliveryId =
                plain.deliveryDriverId != null ? Number(plain.deliveryDriverId) : null;
            return {
                ...plain,
                pickupAssignedToStaff: pickupId != null && pickupId !== Number(agentId),
                deliveryAssignedToStaff:
                    deliveryId != null && deliveryId !== Number(agentId),
                isPickupUnassigned: pickupId == null || pickupId === Number(agentId),
                isDeliveryUnassigned: deliveryId == null || deliveryId === Number(agentId),
            };
        });

        return { jobs, shopAddressId: shopAddress.id };
    }
}

module.exports = new AgentDriverManagementService();

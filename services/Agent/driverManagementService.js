require("dotenv").config();
const {
    users,
    bussinessInformation,
    driverInZones,
    addressDb,
    booking,
    bookingHistory,
} = require('../../models');
const { Op } = require('sequelize');
const {
    NotFoundError,
    ValidationError,
} = require('../../middlewares/universalErrorHandler');
const momentTz = require('moment-timezone');

const AGENT_BUSINESS_TIME_ZONE = "Europe/London";
const LAUNDRY_SHOP_DRIVER_ROLE_ID = 6;

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
                            roleId: LAUNDRY_SHOP_DRIVER_ROLE_ID,
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
                roleId: LAUNDRY_SHOP_DRIVER_ROLE_ID,
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
     * Assign pickup or delivery staff. Does NOT jump booking to Out for Delivery.
     * Body: { bookingId, driverId|staffId, assignmentType?: 'pickup'|'delivery' }
     */
    async assignBookingStaff(data, agentId) {
        const {
            bookingId,
            driverId,
            staffId,
            assignmentType = 'pickup',
            timeZone,
            clientTimeZone,
        } = data;

        if (!bookingId) {
            throw new ValidationError('bookingId is required');
        }

        const targetStaffId = staffId ?? driverId;
        const { shopAddress } = await this._getShopContext(agentId);
        const bookingRow = await this._assertBookingOwnedByShop(bookingId, shopAddress.id);
        const staff = await this._assertAssignableStaff(agentId, targetStaffId);
        const { field, label } = this._assignmentField(assignmentType);

        const updatePayload = { [field]: staff.id };
        await booking.update(updatePayload, { where: { id: bookingId } });

        await this._writeAssignmentHistory(
            bookingId,
            bookingRow.bookingStatusId,
            timeZone,
            clientTimeZone
        );

        return {
            message: `${label} staff assigned successfully`,
            bookingId: Number(bookingId),
            assignmentType: label,
            assignedTo: {
                id: staff.id,
                firstName: staff.firstName || null,
                lastName: staff.lastName || null,
                isOwner: !!staff.isOwner,
            },
        };
    }

    /**
     * Backward-compatible wrapper — assigns pickup staff without forcing status 13.
     */
    async agentAssignBookingToLaundryDriver(data, agentId) {
        return this.assignBookingStaff(
            { ...data, assignmentType: 'pickup' },
            agentId
        );
    }

    /**
     * Unassign staff: return pickup/delivery field to shop owner (shop-held).
     */
    async unassignBookingStaff(data, agentId) {
        const { bookingId, assignmentType = 'pickup', timeZone, clientTimeZone } = data;
        if (!bookingId) {
            throw new ValidationError('bookingId is required');
        }

        const { shopAddress } = await this._getShopContext(agentId);
        const bookingRow = await this._assertBookingOwnedByShop(bookingId, shopAddress.id);
        const { field, label } = this._assignmentField(assignmentType);

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

        return {
            message: `${label} staff unassigned; job returned to shop owner`,
            bookingId: Number(bookingId),
            assignmentType: label,
            assignedTo: { id: agentId, isOwner: true },
        };
    }

    /**
     * Reassign to another staff member (atomic field swap).
     */
    async reassignBookingStaff(data, agentId) {
        return this.assignBookingStaff(data, agentId);
    }

    /**
     * Owner takes the job themselves (pickup by default).
     */
    async agentPickupOrderBySelf(data, agentId) {
        const {
            bookingId,
            staffId,
            assignmentType = 'pickup',
            timeZone,
            clientTimeZone,
        } = data;
        return this.assignBookingStaff(
            {
                bookingId,
                staffId: staffId != null ? staffId : agentId,
                assignmentType,
                timeZone,
                clientTimeZone,
            },
            agentId
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
            bookingStatusId: { [Op.notIn]: [16, 18, 19] }, // completed / cancelled / refunded
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

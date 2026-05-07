require("dotenv").config();
const { 
    users, 
    bussinessInformation, 
    driverInZones, 
    addressDb, 
    booking, 
    bookingHistory 
} = require('../../models');
const { Op } = require('sequelize');
const { 
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError 
} = require('../../middlewares/universalErrorHandler');
const momentTz = require('moment-timezone');

const AGENT_BUSINESS_TIME_ZONE = "Europe/London";

/**
 * Agent Driver Management Service
 * Handles all agent driver related business logic
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
            time: wallClock.format('HH:mm:ss')
        };
    }

    /**
     * Get All Agent Drivers
     * @param {number} agentId - Agent ID
     * @returns {Object} Agent drivers data
     */
    async agnetDrivers(agentId) {
        const laundryShopFound = await bussinessInformation.findOne({
            where: {
                agentId: agentId,
            },
        });

        console.log("🚀 ~ agnetDrivers ~ laundryShopFound:", laundryShopFound);
        //return res.json(laundryShopFound)
        
        if (!laundryShopFound) {
            throw new NotFoundError("Laundry shop not found for this agent");
        }

        const driverFound = await driverInZones.findAll({
            where: {
                laundaryShopId: 1,
            },
            include: [
                {
                    model: users,
                    as: "driverInZone",
                    where: {
                        classifiedAsId: 1,
                        roleId: 6,
                    },
                    attributes: ["id", "firstName", "lastName", "email"],
                },
                {
                    model: bussinessInformation,
                    as: "laundaryDriver",
                    attributes: ["shopAddressId"],
                    include: [
                        {
                            model: addressDb,
                            where: {
                                addressType: "LaundaryShopAddress",
                            },
                            attributes: [
                                "streetAddress",
                                "province",
                                "lat",
                                "lng",
                                "addressType",
                            ],
                        },
                    ],
                },
            ],
            attributes: ["id", "status", "cityId", "countryId", "zoneId"],
        });

        return {
            driverFound,
        };
    }

    /**
     * Agent Assign Booking To Laundry Driver
     * @param {Object} data - Assignment data
     * @param {number} data.driverId - Driver ID
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Assignment result
     */
    async agentAssignBookingToLaundryDriver(data) {
        const { driverId, bookingId, timeZone, clientTimeZone } = data;

        const orderAssign = await booking.update(
            {
                driverId: driverId,
                bookingStatusId: 13,
            },
            {
                where: {
                    id: bookingId,
                },
            }
        );

        const { date: currentDate, time: currentTime } = this._getWallClockDateTime(timeZone || clientTimeZone);

        await bookingHistory.create({
            date: currentDate,
            time: currentTime,
            bookingId: bookingId,
            bookingStatusId: 13,
        });

        return {
            orderAssign,
        };
    }

    /**
     * Agent Pickup Order By Self
     * @param {Object} data - Self pickup data
     * @param {number} data.bookingId - Booking ID
     * @param {number} agentId - Agent ID
     * @returns {Object} Self pickup result
     */
    async agentPickupOrderBySelf(data, agentId) {
        const { bookingId, timeZone, clientTimeZone } = data;

        const agentByselfPickup = await booking.update(
            {
                driverId: agentId,
                bookingStatusId: 13,
            },
            {
                where: {
                    id: bookingId,
                },
            }
        );

        const { date: currentDate, time: currentTime } = this._getWallClockDateTime(timeZone || clientTimeZone);

        await bookingHistory.create({
            date: currentDate,
            time: currentTime,
            bookingId: bookingId,
            bookingStatusId: 13,
        });

        return {
            agentByselfPickup,
        };
    }
}

module.exports = new AgentDriverManagementService();

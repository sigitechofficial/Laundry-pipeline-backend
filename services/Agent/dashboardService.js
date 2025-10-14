require("dotenv").config();
const { 
    users, 
    addressDb, 
    booking, 
    countries, 
    cities, 
    bookingStatus,
    driverInZones,
    bussinessInformation
} = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('sequelize');
const { 
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError 
} = require('../../middlewares/universalErrorHandler');

/**
 * Agent Dashboard Service
 * Handles all agent dashboard related business logic
 */
class AgentDashboardService {

    /**
     * Get Booking Home - Get available bookings for agent
     * @param {number} agentId - Agent ID
     * @returns {Object} Available bookings data
     */
    async getBookingHome(agentId) {
        const userData = await users.findOne({
            where: {
                id: agentId,
            },
            include: [
                {
                    model: addressDb,
                    attributes: [
                        "id",
                        "streetAddress",
                        "zoneId",
                        "lat",
                        "lng",
                        "addressType",
                    ],
                },
            ],
        });

        if (!userData || !userData.addressDb) {
            throw new NotFoundError("Agent address not found");
        }

        let agentZone = userData.addressDb.zoneId;
        const currentDate = new Date();
        currentDate.setSeconds(0, 0);
        const currentTimeString = currentDate.toTimeString().slice(0, 5);
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const bookingData = await booking.findAll({
            where: {
                laundryShopId: null,
                bookingStatusId: 1,
                zoneId: agentZone,
                orderExpireTime: {
                    [Op.gte]: currentTimeString
                },
                createdAt: {
                    [Op.gte]: twentyFourHoursAgo
                }
            },
            include: [
                {
                    model: addressDb,
                    as: "pickupAddress",
                    attributes: ["id", "streetAddress", "district", "province", "postalcode", "lat", "lng", "addressType"],
                    include: [
                        {
                            model: countries,
                            attributes: ['id', 'name', 'shortName']
                        },
                        {
                            model: cities,
                            attributes: ['id', 'name']
                        }
                    ]
                },
                {
                    model: users,
                    as: "customer",
                    attributes: ["id", "firstName", "lastName", "email", "phoneNum", "image"],
                    include: [
                        {
                            model: countries,
                            attributes: ["id", "name", "shortName"],
                        },
                        {
                            model: cities,
                            attributes: ["id", "name"],
                        },
                    ],
                },
                {
                    model: bookingStatus,
                    attributes: ["id", "name"],
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        return {
            bookingData,
            message: "Available bookings fetched"
        };
    }

    /**
     * Get Performance Dashboard
     * @param {Object} data - Dashboard data
     * @param {string} data.startDate - Start date
     * @param {string} data.endDate - End date
     * @param {number} agentId - Agent ID
     * @returns {Object} Performance dashboard data
     */
    async getPerformanceDashboard(data, agentId) {
        const { startDate, endDate } = data;

        // Normalize date range
        let start = startDate ? new Date(startDate) : new Date();
        let end = endDate ? new Date(endDate) : new Date();

        if (!startDate || !endDate) {
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);
        }

        // Compute comparison period
        const durationInMs = end.getTime() - start.getTime();
        console.log("durationInMs============>>>>>>>>>>>>>>>>>>", durationInMs)
        const compStart = new Date(start.getTime() - durationInMs);
        console.log("compStart===========================================>>>>>>", compStart)
        const compEnd = new Date(start.getTime());
        console.log("compEnd===========================================>>>>>>", compEnd)

        // Agent Shop Address
        const findAgentShopAddress = await addressDb.findOne({
            where: { userId: agentId },
        });

        if (!findAgentShopAddress) {
            throw new NotFoundError("Agent shop address not found");
        }

        // Today's Summary
        const todaySummaryRaw = await booking.findAll({
            where: {
                laundryShopId: findAgentShopAddress.id,
                createdAt: {
                    [Op.between]: [start, end]
                }
            },
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('id')), 'pickups'],
                [sequelize.literal('ROUND(SUM(orderAmount), 2)'), 'earnings']
            ],
            raw: true
        });

        // Comparison Period Summary
        const comparisonSummary = await booking.findAll({
            where: {
                laundryShopId: findAgentShopAddress.id,
                createdAt: {
                    [Op.between]: [compStart, compEnd]
                }
            },
            attributes: [
                [sequelize.literal('ROUND(SUM(orderAmount), 2)'), 'earnings']
            ],
            raw: true
        });

        const earningsNow = parseFloat(todaySummaryRaw[0]?.earnings || 0);
        const earningsPrev = parseFloat(comparisonSummary[0]?.earnings || 0);

        const MAX_CHANGE = 200;

        let earningsDiffPercent = 0;
        if (earningsPrev > 0) {
            const rawChange = ((earningsNow - earningsPrev) / earningsPrev) * 100;
            const scaled = (rawChange / MAX_CHANGE) * 100;
            earningsDiffPercent = Math.min(Math.max(scaled, 1), 100);
            earningsDiffPercent = parseFloat(earningsDiffPercent.toFixed(2));
        }

        const todaySummary = {
            ...todaySummaryRaw[0],
            earningsComparison: earningsDiffPercent
        };

        // Delivery Type Split (Agent Drivers only)
        const agentDriverIds = await users.findAll({
            where: {
                roleId: 6,
                employeeOff: agentId
            },
            attributes: ['id'],
            raw: true
        });

        const driverIds = agentDriverIds.map(d => d.id);

        let deliveryWhere = {
            [Op.or]: [
                { deliveryDriverId: { [Op.in]: driverIds } },
                { driverId: { [Op.in]: driverIds } }
            ]
        };

        // Add date filter to delivery queries
        deliveryWhere.createdAt = { [Op.between]: [start, end] };

        const deliveryTypeSplit = await booking.findAll({
            where: deliveryWhere,
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('id')), 'totalDeliveries'],
                [sequelize.literal('ROUND(SUM(orderAmount), 2)'), 'totalEarnings']
            ],
            raw: true
        });

        // Recent Bookings
        const recentBookings = await booking.findAll({
            where: {
                laundryShopId: findAgentShopAddress.id,
                createdAt: {
                    [Op.between]: [start, end]
                }
            },
            include: [
                {
                    model: users,
                    as: "customer",
                    attributes: ["firstName", "lastName", "email"]
                },
                {
                    model: bookingStatus,
                    attributes: ["name"]
                }
            ],
            order: [['createdAt', 'DESC']],
            limit: 10
        });

        // Zone Performance
        const zonePerformance = await booking.findAll({
            where: {
                laundryShopId: findAgentShopAddress.id,
                createdAt: {
                    [Op.between]: [start, end]
                }
            },
            attributes: [
                'zoneId',
                [sequelize.fn('COUNT', sequelize.col('id')), 'bookingsCount'],
                [sequelize.literal('ROUND(SUM(orderAmount), 2)'), 'totalEarnings']
            ],
            group: ['zoneId'],
            raw: true
        });

        return {
            todaySummary,
            deliveryTypeSplit: deliveryTypeSplit[0] || { totalDeliveries: 0, totalEarnings: 0 },
            recentBookings,
            zonePerformance,
            message: "Performance dashboard data fetched"
        };
    }
}

module.exports = new AgentDashboardService();

const { users, booking, billingDetails, bookingHistory } = require('../../models');
const { Op } = require('sequelize');
const { 
    ValidationError, 
    NotFoundError, 
    ConflictError,
    UnprocessableEntityError 
} = require('../../middlewares/universalErrorHandler');

class DashboardService {
    /**
     * Get admin dashboard statistics
     * @returns {Object} Dashboard data including revenue, counts, and metrics
     */
    async getDashboardData() {
        // Get total revenue from zone admin commission
        const revenue = await billingDetails.sum("zoneAdminCommission", {
            where: {
                zoneAdminCommission: {
                    [Op.ne]: null,
                },
            },
        });

        // Validate revenue data
        if (revenue === null || revenue === undefined) {
            throw new ValidationError('Unable to calculate revenue data');
        }

        // Get total counts
        const totalBookings = await booking.count();
        const totalUsers = await users.count();

        const totalCustomer = await users.count({
            where: {
                userTypeId: 2,
                status: true,
            },
        });

        const totalAgent = await users.count({
            where: {
                userTypeId: 4,
            },
        });

        const totalAgentActive = await users.count({
            where: {
                userTypeId: 4,
                status: true,
            },
        });

        // Get completed bookings for average completion time calculation
        const completedBookings = await booking.findAll({
            where: {
                bookingStatusId: 17,
            },
            include: [
                {
                    model: bookingHistory,
                    where: {
                        bookingStatusId: 17,
                    },
                    required: true,
                },
            ],
        });

        // Validate completed bookings data
        if (!completedBookings || completedBookings.length === 0) {
            // Return dashboard data with zero completion metrics
            return {
                adminRevenue: revenue || 0,
                totalBookings: totalBookings || 0,
                totalUsers: totalUsers || 0,
                totalCustomers: totalCustomer || 0,
                totalAgents: totalAgent || 0,
                totalAgentActive: totalAgentActive || 0,
                averageOrderCompletionTimeHours: 0,
                completedOrdersCount: 0,
                agentAcceptanceRate: 0,
            };
        }

        // Calculate average completion time
        let totalCompletionTime = 0;
        let completedCount = 0;

        for (const bookingItem of completedBookings) {
            const creationHistory = await bookingHistory.findOne({
                where: {
                    bookingId: bookingItem.id,
                    bookingStatusId: 1,
                },
            });

            const completionHistory = await bookingHistory.findOne({
                where: {
                    bookingId: bookingItem.id,
                    bookingStatusId: 17,
                },
            });

            if (creationHistory && completionHistory) {
                const creationDateTime = new Date(`${creationHistory.date} ${creationHistory.time}`);
                const completionDateTime = new Date(`${completionHistory.date} ${completionHistory.time}`);

                const timeDiff = completionDateTime - creationDateTime;
                totalCompletionTime += timeDiff;
                completedCount++;
            }
        }

        const averageCompletionTimeHours =
            completedCount > 0 ? totalCompletionTime / completedCount / (1000 * 60 * 60) : 0;

        // Get agent acceptance metrics
        const acceptedByAgents = await booking.count({
            where: {
                driverId: {
                    [Op.ne]: null,
                },
            },
        });

        const assignedToAgents = await booking.count({
            where: {
                deliveryDriverId: {
                    [Op.ne]: null,
                },
            },
        });

        // Validate agent metrics
        if (assignedToAgents < 0 || acceptedByAgents < 0) {
            throw new ValidationError('Invalid agent metrics data');
        }

        const agentAcceptanceRate =
            assignedToAgents > 0
                ? Math.round((acceptedByAgents / assignedToAgents) * 100) / 100
                : 0;

        return {
            adminRevenue: revenue,
            totalBookings: totalBookings,
            totalUsers: totalUsers,
            totalCustomers: totalCustomer,
            totalAgents: totalAgent,
            totalAgentActive: totalAgentActive,
            averageOrderCompletionTimeHours: Math.round(averageCompletionTimeHours * 100) / 100,
            completedOrdersCount: completedCount,
            agentAcceptanceRate: agentAcceptanceRate,
        };
    }
}

module.exports = new DashboardService();
